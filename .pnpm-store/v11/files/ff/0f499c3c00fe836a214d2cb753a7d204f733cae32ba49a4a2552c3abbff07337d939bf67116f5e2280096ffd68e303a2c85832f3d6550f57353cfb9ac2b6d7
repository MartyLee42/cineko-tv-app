import WritingDirection from './WritingDirection';
interface NodeLayout {
    left: number;
    top: number;
    readonly right: number;
    readonly bottom: number;
    width: number;
    height: number;
}
declare class VisualDebugger {
    private debugCtx;
    private layoutsCtx;
    private writingDirection;
    constructor(writingDirection: WritingDirection);
    static createCanvas(id: string, zIndex: string, writingDirection: WritingDirection): CanvasRenderingContext2D;
    clear(): void;
    clearLayouts(): void;
    drawLayout(layout: NodeLayout, focusKey: string, parentFocusKey: string): void;
    drawPoint(x: number, y: number, color?: string, size?: number): void;
}
export default VisualDebugger;
