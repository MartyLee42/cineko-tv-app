// Around a lazy part the app can do without (a loading style, the intro, the
// cozy / holiday layers): when its chunk fails to download, `fallback` shows
// instead and chunkReload.ts decides about a reload. Any other error goes on
// to the app's ErrorBoundary as before.
import { Component, type ReactNode } from "react";
import { isChunkLoadError } from "@martytv/ui/chunk-reload";
import { chunkFailed } from "./chunkReload";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** The chunk failed (e.g. the intro ends itself). */
  onFail?: () => void;
}

export class ChunkBoundary extends Component<Props, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    if (!isChunkLoadError(error)) return;
    void chunkFailed(error);
    this.props.onFail?.();
  }

  render() {
    const e = this.state.error;
    if (e === null) return this.props.children;
    if (!isChunkLoadError(e)) throw e;
    return this.props.fallback ?? null;
  }
}
