import React, { useRef, useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Pencil, Circle, ArrowUpRight, Trash2, X } from "lucide-react";

type Tool = "pencil" | "circle" | "arrow";

interface DrawingOverlayProps {
  imageUrl: string;
  onAnnotatedImage: (dataUrl: string) => void;
  onCancel: () => void;
}

const STROKE_COLOR = "#FF0000";
const STROKE_WIDTH = 3;

const DrawingOverlay: React.FC<DrawingOverlayProps> = ({ imageUrl, onAnnotatedImage, onCancel }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>("pencil");
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [paths, setPaths] = useState<ImageData[]>([]);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

  // Load image and set canvas size
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      const container = containerRef.current;
      if (!container) return;

      const maxW = container.clientWidth - 32;
      const maxH = container.clientHeight - 120;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      setCanvasSize({ w, h });

      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const getPos = (e: React.MouseEvent | React.TouchEvent): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  const redrawBase = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }, []);

  const saveState = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    setPaths((prev) => [...prev, ctx.getImageData(0, 0, canvas.width, canvas.height)]);
  };

  const handlePointerDown = (e: React.MouseEvent) => {
    const pos = getPos(e);
    setIsDrawing(true);
    setStartPoint(pos);

    if (tool === "pencil") {
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      ctx.strokeStyle = STROKE_COLOR;
      ctx.lineWidth = STROKE_WIDTH;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
  };

  const handlePointerMove = (e: React.MouseEvent) => {
    if (!isDrawing) return;
    const pos = getPos(e);

    if (tool === "pencil") {
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    } else if (startPoint) {
      // Preview shape
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d")!;

      // Restore last saved state or base image
      if (paths.length > 0) {
        ctx.putImageData(paths[paths.length - 1], 0, 0);
      } else {
        redrawBase();
      }

      ctx.strokeStyle = STROKE_COLOR;
      ctx.lineWidth = STROKE_WIDTH;

      if (tool === "circle") {
        const rx = Math.abs(pos.x - startPoint.x) / 2;
        const ry = Math.abs(pos.y - startPoint.y) / 2;
        const cx = (pos.x + startPoint.x) / 2;
        const cy = (pos.y + startPoint.y) / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (tool === "arrow") {
        drawArrow(ctx, startPoint.x, startPoint.y, pos.x, pos.y);
      }
    }
  };

  const handlePointerUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    saveState();
    setStartPoint(null);
  };

  const drawArrow = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) => {
    const headLen = 15;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  };

  const handleClear = () => {
    setPaths([]);
    redrawBase();
  };

  const handleConfirm = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onAnnotatedImage(canvas.toDataURL("image/png"));
  };

  // Touch support
  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
    handlePointerDown(e as any);
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    handlePointerMove(e as any);
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault();
    handlePointerUp();
  };

  return (
    <div ref={containerRef} className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm">
      {/* Toolbar */}
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-card p-2 shadow-md">
        <Button
          variant={tool === "pencil" ? "default" : "outline"}
          size="sm"
          onClick={() => setTool("pencil")}
          title="Lápis livre"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant={tool === "circle" ? "default" : "outline"}
          size="sm"
          onClick={() => setTool("circle")}
          title="Círculo"
        >
          <Circle className="h-4 w-4" />
        </Button>
        <Button
          variant={tool === "arrow" ? "default" : "outline"}
          size="sm"
          onClick={() => setTool("arrow")}
          title="Seta"
        >
          <ArrowUpRight className="h-4 w-4" />
        </Button>
        <div className="mx-1 h-6 w-px bg-border" />
        <Button variant="outline" size="sm" onClick={handleClear} title="Limpar marcações">
          <Trash2 className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel} title="Cancelar">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={canvasSize.w}
        height={canvasSize.h}
        className="cursor-crosshair rounded-lg border border-border shadow-sm"
        style={{ width: canvasSize.w, height: canvasSize.h }}
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onMouseLeave={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />

      {/* Confirm */}
      <div className="mt-3 flex gap-2">
        <Button onClick={handleConfirm} size="sm">
          Usar imagem marcada
        </Button>
      </div>
    </div>
  );
};

export default DrawingOverlay;
