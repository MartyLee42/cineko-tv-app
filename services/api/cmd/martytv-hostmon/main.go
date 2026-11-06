// Command martytv-hostmon is a tiny host monitor for Cineko's admin
// "Server" tab. It runs as a systemd service on the host (see
// deployments/hostmon/martytv-hostmon.service), reads /proc, statfs("/") and
// the Docker Engine API (read-only GETs: container list and one-shot stats),
// samples every 10 s into a 1 h in-memory ring, and answers JSON on a unix
// socket only:
//
//	GET /v1/status              host CPU/RAM/swap/load/disks/net, top processes, containers
//	GET /v1/history?minutes=60  10 s samples
//
// There is no TCP listener. Access is controlled by the socket's file
// permissions (0660, owned by -socket-uid, the API container's user). Only
// process names, pids, RSS and CPU% are exposed — never command lines or
// environments.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"martytv/api/internal/sysmon"
)

func main() {
	socket := flag.String("socket", "/run/martytv/hostmon.sock", "unix socket to listen on")
	uid := flag.Int("socket-uid", 65532, "owner of the socket (the API container's uid; -1 = keep)")
	gid := flag.Int("socket-gid", 65532, "group of the socket (-1 = keep)")
	proc := flag.String("proc", "/proc", "procfs mount")
	root := flag.String("root", "/", "filesystem to report (statfs only)")
	dockerSock := flag.String("docker", "/var/run/docker.sock", "Docker Engine socket for container stats (empty = off)")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(*socket, *uid, *gid, *proc, *root, *dockerSock, log); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(socket string, uid, gid int, proc, root, dockerSock string, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var docker *sysmon.Docker
	if dockerSock != "" {
		docker = sysmon.NewDocker(dockerSock)
	}
	hm := sysmon.NewHostmon(sysmon.NewCollector(proc, "host", root), docker, log)

	if err := os.MkdirAll(filepath.Dir(socket), 0o755); err != nil {
		return err
	}
	// A stale socket from a previous run blocks bind.
	if err := os.Remove(socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	old := syscall.Umask(0o177)
	ln, err := net.Listen("unix", socket)
	syscall.Umask(old)
	if err != nil {
		return err
	}
	defer os.Remove(socket)
	// chmod first: once the socket belongs to the container user, root needs
	// CAP_FOWNER (deliberately not granted by the unit) to change its mode.
	if err := os.Chmod(socket, 0o660); err != nil {
		return fmt.Errorf("chmod socket: %w", err)
	}
	if err := os.Chown(socket, uid, gid); err != nil {
		return fmt.Errorf("chown socket: %w", err)
	}

	go hm.Run(ctx)
	srv := &http.Server{
		Handler:           hm.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("martytv-hostmon listening", "socket", socket, "docker", dockerSock != "")
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
