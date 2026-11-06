package iptv

import (
	"bufio"
	"compress/gzip"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"golang.org/x/text/encoding/charmap"
)

// XChannel is an XMLTV <channel>.
type XChannel struct {
	ID    string
	Names []string
	Icon  string
}

// XProgramme is an XMLTV <programme>.
type XProgramme struct {
	Channel     string
	Start, Stop time.Time
	Title       string
	Description string
	Category    string
}

// MaybeGunzip returns a reader that transparently decompresses gzip input
// (detected by its magic bytes, whatever the URL or Content-Type says).
func MaybeGunzip(r io.Reader) (io.Reader, error) {
	br := bufio.NewReaderSize(r, 64<<10)
	head, _ := br.Peek(2)
	if len(head) == 2 && head[0] == 0x1f && head[1] == 0x8b {
		zr, err := gzip.NewReader(br)
		if err != nil {
			return nil, err
		}
		zr.Multistream(true)
		return zr, nil
	}
	return br, nil
}

// errStop lets a callback end parsing early without an error.
var errStop = errors.New("stop")

// ParseXMLTV streams an XMLTV document (plain or gzip) and calls onChannel
// for every <channel> and onProgramme for every <programme> as they are
// read; nothing but the current element is kept in memory. Programmes
// with unparsable times or no title are skipped. A callback may return
// errStop to end early.
func ParseXMLTV(r io.Reader, onChannel func(XChannel) error, onProgramme func(XProgramme) error) error {
	return parseXMLTV(r, onChannel, nil, onProgramme)
}

// parseXMLTV is ParseXMLTV with an optional programme filter: programmes
// whose channel want rejects are skipped without decoding (most of a big
// guide belongs to channels nobody has). Errors say what went wrong where:
// "truncated at byte N" (gzip or XML ends early) or "parse_error at byte N: …"
// (offsets are in the decompressed XML).
func parseXMLTV(r io.Reader, onChannel func(XChannel) error, want func(channel string) bool, onProgramme func(XProgramme) error) error {
	r, err := MaybeGunzip(r)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	dec := xml.NewDecoder(r)
	dec.Strict = false
	dec.CharsetReader = charsetReader
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return xmlErr(dec, err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "channel":
			var c struct {
				ID    string `xml:"id,attr"`
				Names []struct {
					Text string `xml:",chardata"`
				} `xml:"display-name"`
				Icon struct {
					Src string `xml:"src,attr"`
				} `xml:"icon"`
			}
			if err := dec.DecodeElement(&c, &se); err != nil {
				return xmlErr(dec, err)
			}
			if c.ID == "" || onChannel == nil {
				continue
			}
			xc := XChannel{ID: strings.TrimSpace(c.ID), Icon: httpOrEmpty(strings.TrimSpace(c.Icon.Src))}
			for _, n := range c.Names {
				if t := strings.TrimSpace(n.Text); t != "" {
					xc.Names = append(xc.Names, t)
				}
			}
			if err := onChannel(xc); err != nil {
				return stopOr(err)
			}
		case "programme":
			if want != nil {
				ch := ""
				for _, a := range se.Attr {
					if a.Name.Local == "channel" {
						ch = strings.TrimSpace(a.Value)
					}
				}
				if !want(ch) {
					if err := dec.Skip(); err != nil {
						return xmlErr(dec, err)
					}
					continue
				}
			}
			var p struct {
				Start   string    `xml:"start,attr"`
				Stop    string    `xml:"stop,attr"`
				Channel string    `xml:"channel,attr"`
				Titles  []langTxt `xml:"title"`
				Descs   []langTxt `xml:"desc"`
				Cats    []langTxt `xml:"category"`
			}
			if err := dec.DecodeElement(&p, &se); err != nil {
				return xmlErr(dec, err)
			}
			if onProgramme == nil {
				continue
			}
			start, err1 := ParseXMLTVTime(p.Start)
			stop, err2 := ParseXMLTVTime(p.Stop)
			title := pickLang(p.Titles)
			if err1 != nil || title == "" || p.Channel == "" {
				continue
			}
			if err2 != nil || !stop.After(start) {
				stop = time.Time{} // filled from the next programme by the caller
			}
			xp := XProgramme{Channel: strings.TrimSpace(p.Channel), Start: start, Stop: stop, Title: clip(title, 300),
				Description: clip(pickLang(p.Descs), 1000), Category: clip(pickLang(p.Cats), 100)}
			if err := onProgramme(xp); err != nil {
				return stopOr(err)
			}
		}
	}
}

// errTruncated / errParse classify guide failures (errors.Is).
var (
	errTruncated = errors.New("truncated")
	errParse     = errors.New("parse_error")
)

func xmlErr(dec *xml.Decoder, err error) error {
	off := dec.InputOffset()
	var se *xml.SyntaxError
	if errors.Is(err, io.ErrUnexpectedEOF) || (errors.As(err, &se) && strings.Contains(se.Msg, "unexpected EOF")) {
		return fmt.Errorf("%w at byte %d", errTruncated, off)
	}
	if errors.Is(err, gzip.ErrChecksum) || errors.Is(err, gzip.ErrHeader) {
		return fmt.Errorf("%w at byte %d: corrupt gzip", errParse, off)
	}
	msg := err.Error()
	if len(msg) > 120 {
		msg = msg[:120]
	}
	return fmt.Errorf("%w at byte %d: %s", errParse, off, msg)
}

func stopOr(err error) error {
	if errors.Is(err, errStop) {
		return nil
	}
	return err
}

type langTxt struct {
	Lang string `xml:"lang,attr"`
	Text string `xml:",chardata"`
}

// pickLang prefers Russian, then English, then the first non-empty text.
func pickLang(xs []langTxt) string {
	best, rank := "", 9
	for _, x := range xs {
		t := strings.TrimSpace(x.Text)
		if t == "" {
			continue
		}
		r := 3
		switch strings.ToLower(x.Lang) {
		case "ru", "rus":
			r = 1
		case "en", "eng":
			r = 2
		}
		if r < rank {
			best, rank = t, r
		}
	}
	return best
}

// ParseXMLTVTime parses "20261029080000 +0300" (offset optional = UTC;
// also "+03:00", "Z", and shorter forms down to YYYYMMDDhhmm).
func ParseXMLTVTime(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, errors.New("empty time")
	}
	stamp, zone, _ := strings.Cut(s, " ")
	if zone == "" && len(stamp) > 14 && (stamp[14] == '+' || stamp[14] == '-' || stamp[14] == 'Z') {
		stamp, zone = stamp[:14], stamp[14:]
	}
	var layout string
	switch len(stamp) {
	case 14:
		layout = "20060102150405"
	case 12:
		layout = "200601021504"
	default:
		return time.Time{}, fmt.Errorf("bad time %q", s)
	}
	t, err := time.ParseInLocation(layout, stamp, time.UTC)
	if err != nil {
		return time.Time{}, err
	}
	zone = strings.TrimSpace(zone)
	if zone == "" || zone == "Z" || strings.EqualFold(zone, "UTC") || strings.EqualFold(zone, "GMT") {
		return t, nil
	}
	zone = strings.ReplaceAll(zone, ":", "")
	if len(zone) != 5 || (zone[0] != '+' && zone[0] != '-') {
		return time.Time{}, fmt.Errorf("bad zone %q", zone)
	}
	var hh, mm int
	if _, err := fmt.Sscanf(zone[1:], "%02d%02d", &hh, &mm); err != nil || hh > 14 || mm > 59 {
		return time.Time{}, fmt.Errorf("bad zone %q", zone)
	}
	off := time.Duration(hh)*time.Hour + time.Duration(mm)*time.Minute
	if zone[0] == '-' {
		off = -off
	}
	return t.Add(-off).UTC(), nil
}

func charsetReader(label string, in io.Reader) (io.Reader, error) {
	switch strings.ToLower(strings.TrimSpace(label)) {
	case "utf-8", "utf8", "us-ascii", "ascii", "":
		return in, nil
	case "windows-1251", "cp1251":
		return charmap.Windows1251.NewDecoder().Reader(in), nil
	case "koi8-r":
		return charmap.KOI8R.NewDecoder().Reader(in), nil
	case "iso-8859-1", "latin1", "latin-1":
		return charmap.ISO8859_1.NewDecoder().Reader(in), nil
	}
	return nil, fmt.Errorf("unsupported charset %q", label)
}
