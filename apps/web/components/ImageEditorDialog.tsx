"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowUpRight, Circle, Crop, Paintbrush, Shapes, Smile, Square, X } from "lucide-react";

type Point = { x: number; y: number };
type ImageCrop = { x: number; y: number; width: number; height: number };
type Annotation =
  | { id: string; kind: "pen"; points: Point[]; color: string; width: number }
  | { id: string; kind: "shape"; shape: "rect" | "circle" | "arrow"; from: Point; to: Point; color: string; width: number }
  | { id: string; kind: "sticker"; emoji: string; point: Point; size: number };
type Tool = "crop" | "pen" | "text" | "shape" | "sticker";
type Gesture = { kind: "crop" | "pen" | "shape"; start: Point; crop?: ImageCrop };
const FULL_CROP: ImageCrop = { x: 0, y: 0, width: 1, height: 1 };

export default function ImageEditorDialog({ file, url, onCancel, onComplete }: { file: File; url: string; onCancel: () => void; onComplete: (file: File | null) => void }) {
  const [tool, setTool] = useState<Tool>("text");
  const [cropEnabled, setCropEnabled] = useState(false);
  const [crop, setCrop] = useState<ImageCrop>(FULL_CROP);
  const [text, setText] = useState("");
  const [textPosition, setTextPosition] = useState<"top" | "center" | "bottom">("bottom");
  const [textColor, setTextColor] = useState<"white" | "black">("white");
  const [textSize, setTextSize] = useState(0.06);
  const [color, setColor] = useState("#e53935");
  const [shape, setShape] = useState<"rect" | "circle" | "arrow">("rect");
  const [sticker, setSticker] = useState("✨");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [busy, setBusy] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const gestureRef = useRef<Gesture | null>(null);

  function pointFromEvent(event: ReactPointerEvent<HTMLDivElement>): Point | null {
    const bounds = imageRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))
    };
  }

  function beginGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const point = pointFromEvent(event);
    if (!point) return;
    if (tool === "sticker") {
      setAnnotations((current) => [...current, { id: crypto.randomUUID(), kind: "sticker", emoji: sticker, point, size: 0.11 }]);
      return;
    }
    if (tool === "text") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "crop" && cropEnabled) {
      gestureRef.current = { kind: "crop", start: point, crop };
      return;
    }
    if (tool === "pen") {
      const next: Annotation = { id: crypto.randomUUID(), kind: "pen", points: [point], color, width: 0.007 };
      gestureRef.current = { kind: "pen", start: point };
      setDraft(next);
    } else if (tool === "shape") {
      const next: Annotation = { id: crypto.randomUUID(), kind: "shape", shape, from: point, to: point, color, width: 0.007 };
      gestureRef.current = { kind: "shape", start: point };
      setDraft(next);
    }
  }

  function moveGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    const point = pointFromEvent(event);
    if (!gesture || !point) return;
    if (gesture.kind === "crop") {
      setCrop({ x: Math.min(point.x, gesture.start.x), y: Math.min(point.y, gesture.start.y), width: Math.max(0.04, Math.abs(point.x - gesture.start.x)), height: Math.max(0.04, Math.abs(point.y - gesture.start.y)) });
    } else if (gesture.kind === "pen") {
      setDraft((current) => current?.kind === "pen" ? { ...current, points: [...current.points, point] } : current);
    } else {
      setDraft((current) => current?.kind === "shape" ? { ...current, to: point } : current);
    }
  }

  function endGesture() {
    if (gestureRef.current?.kind === "pen" || gestureRef.current?.kind === "shape") {
      if (draft) setAnnotations((items) => [...items, draft]);
      setDraft(null);
    }
    gestureRef.current = null;
  }

  function toggleCrop() {
    setTool("crop");
    if (cropEnabled) setCropEnabled(false);
    else { setCrop(FULL_CROP); setCropEnabled(true); }
  }

  async function saveImage() {
    const image = imageRef.current;
    if (!image?.naturalWidth || busy) return;
    setBusy(true);
    try {
      await document.fonts?.ready;
      const area = cropEnabled ? crop : FULL_CROP;
      const sx = Math.max(0, Math.round(area.x * image.naturalWidth));
      const sy = Math.max(0, Math.round(area.y * image.naturalHeight));
      const sw = Math.max(1, Math.min(image.naturalWidth - sx, Math.round(area.width * image.naturalWidth)));
      const sh = Math.max(1, Math.min(image.naturalHeight - sy, Math.round(area.height * image.naturalHeight)));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const context = canvas.getContext("2d");
      if (!context) { onComplete(null); return; }
      context.fillStyle = "#fff";
      context.fillRect(0, 0, sw, sh);
      context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

      const mapX = (value: number) => (value - area.x) * sw / area.width;
      const mapY = (value: number) => (value - area.y) * sh / area.height;
      for (const item of annotations) {
        if (item.kind === "sticker") {
          context.font = `${Math.max(24, Math.round(sw * item.size))}px system-ui, sans-serif`;
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillText(item.emoji, mapX(item.point.x), mapY(item.point.y));
        } else if (item.kind === "pen") {
          if (!item.points.length) continue;
          context.beginPath();
          context.moveTo(mapX(item.points[0].x), mapY(item.points[0].y));
          for (const point of item.points.slice(1)) context.lineTo(mapX(point.x), mapY(point.y));
          context.strokeStyle = item.color;
          context.lineWidth = Math.max(3, Math.round(sw * item.width / area.width));
          context.lineCap = "round";
          context.lineJoin = "round";
          context.stroke();
        } else {
          const x1 = mapX(item.from.x), y1 = mapY(item.from.y), x2 = mapX(item.to.x), y2 = mapY(item.to.y);
          context.strokeStyle = item.color;
          context.lineWidth = Math.max(3, Math.round(sw * item.width / area.width));
          context.lineCap = "round";
          if (item.shape === "rect") context.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
          else if (item.shape === "circle") {
            context.beginPath();
            context.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
            context.stroke();
          }
          else {
            const angle = Math.atan2(y2 - y1, x2 - x1), head = Math.max(16, sw * 0.025);
            context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
            context.moveTo(x2, y2); context.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6)); context.stroke();
          }
        }
      }

      const fontSize = Math.max(24, Math.round(sw * textSize));
      context.font = `700 ${fontSize}px Cairo, sans-serif`;
      context.direction = "rtl";
      context.textAlign = "center";
      context.textBaseline = "middle";
      const lines = text.split(/\r?\n/).flatMap((paragraph) => {
        const words = paragraph.trim().split(/\s+/).filter(Boolean);
        if (!words.length) return [""];
        const wrapped: string[] = [];
        let line = "";
        for (const word of words) {
          const next = line ? `${line} ${word}` : word;
          if (line && context.measureText(next).width > sw * 0.86) { wrapped.push(line); line = word; }
          else line = next;
        }
        wrapped.push(line);
        return wrapped;
      }).slice(0, 5);
      if (text.trim()) {
        const lineHeight = Math.round(fontSize * 1.3);
        const bandHeight = lineHeight * lines.length + fontSize * 0.65;
        const margin = Math.round(sh * 0.035);
        const top = textPosition === "top" ? margin : textPosition === "center" ? Math.round((sh - bandHeight) / 2) : sh - bandHeight - margin;
        context.fillStyle = textColor === "white" ? "rgba(0,0,0,.62)" : "rgba(255,255,255,.8)";
        context.fillRect(0, top, sw, bandHeight);
        context.fillStyle = textColor === "white" ? "#fff" : "#171717";
        lines.forEach((line, index) => context.fillText(line, sw / 2, top + fontSize * 0.45 + index * lineHeight, sw * 0.88));
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) { onComplete(null); return; }
      const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
      onComplete(new File([blob], `${baseName}-edited.jpg`, { type: "image/jpeg" }));
    } catch {
      onComplete(null);
    } finally { setBusy(false); }
  }

  const cropArea = cropEnabled ? crop : FULL_CROP;
  const textPositionClass = textPosition === "top" ? "top-2" : textPosition === "center" ? "top-1/2 -translate-y-1/2" : "bottom-2";
  const shapes: { id: "rect" | "circle" | "arrow"; label: string; icon: typeof Square }[] = [
    { id: "rect", label: "مستطيل", icon: Square }, { id: "circle", label: "دائرة", icon: Circle }, { id: "arrow", label: "سهم", icon: ArrowUpRight }
  ];

  return <div role="dialog" aria-modal="true" aria-labelledby="image-editor-title" className="fixed inset-0 z-[75] grid place-items-center bg-stone-950/75 p-2 backdrop-blur-sm sm:p-4" onClick={onCancel}>
    <section className="panel flex max-h-[96dvh] w-full max-w-4xl flex-col overflow-hidden p-3 sm:p-5" onClick={(event) => event.stopPropagation()}>
      <header className="mb-3 flex items-start justify-between gap-3"><div><h2 id="image-editor-title" className="flex items-center gap-2 text-sm font-extrabold"><Paintbrush size={16} className="text-amber-700" /> تعديل الصورة</h2><p className="mt-1 text-[10px] text-stone-500">القص اختياري. اختر أداة ثم عدّل الصورة قبل الإرسال.</p></div><button type="button" onClick={onCancel} aria-label="إلغاء تعديل الصورة" className="rounded-lg p-1 text-stone-400 hover:bg-stone-100"><X size={20} /></button></header>

      <div className="mb-3 flex flex-wrap items-center gap-1.5 border-y border-stone-100 py-2">
        <button type="button" aria-pressed={tool === "crop" && cropEnabled} onClick={toggleCrop} className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-[10px] font-bold ${tool === "crop" && cropEnabled ? "bg-amber-100 text-amber-900" : "bg-stone-50 text-stone-600 hover:bg-amber-50"}`}><Crop size={15} /> قص {cropEnabled ? "مفعّل" : "اختياري"}</button>
        <button type="button" aria-pressed={tool === "pen"} onClick={() => setTool("pen")} className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-[10px] font-bold ${tool === "pen" ? "bg-red-100 text-red-800" : "bg-stone-50 text-stone-600 hover:bg-red-50"}`}><Paintbrush size={15} /> رسم</button>
        <button type="button" aria-pressed={tool === "text"} onClick={() => setTool("text")} className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-[10px] font-bold ${tool === "text" ? "bg-sky-100 text-sky-800" : "bg-stone-50 text-stone-600 hover:bg-sky-50"}`}>نص</button>
        <button type="button" aria-pressed={tool === "shape"} onClick={() => setTool("shape")} className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-[10px] font-bold ${tool === "shape" ? "bg-violet-100 text-violet-800" : "bg-stone-50 text-stone-600 hover:bg-violet-50"}`}><Shapes size={15} /> أشكال</button>
        <button type="button" aria-pressed={tool === "sticker"} onClick={() => setTool("sticker")} className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-[10px] font-bold ${tool === "sticker" ? "bg-pink-100 text-pink-800" : "bg-stone-50 text-stone-600 hover:bg-pink-50"}`}><Smile size={15} /> ملصقات</button>
        {(tool === "pen" || tool === "shape") && <label title="لون الرسم" className="flex h-9 items-center gap-2 rounded-lg bg-stone-50 px-2 text-[10px] font-bold text-stone-500">اللون<input aria-label="لون الرسم" type="color" value={color} onChange={(event) => setColor(event.target.value)} className="h-6 w-7 cursor-pointer border-0 bg-transparent p-0" /></label>}
        {tool === "shape" && <div className="flex gap-1">{shapes.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-label={label} aria-pressed={shape === id} onClick={() => setShape(id)} className={`grid h-9 w-9 place-items-center rounded-lg ${shape === id ? "bg-violet-100 text-violet-800" : "bg-stone-50 text-stone-500"}`}><Icon size={15} /></button>)}</div>}
        {tool === "sticker" && <div className="flex gap-1">{["✨", "🎉", "❤️", "⭐", "🎂", "👍"].map((emoji) => <button type="button" key={emoji} aria-label={`اختيار ملصق ${emoji}`} aria-pressed={sticker === emoji} onClick={() => setSticker(emoji)} className={`grid h-9 w-9 place-items-center rounded-lg text-lg ${sticker === emoji ? "bg-pink-100" : "bg-stone-50"}`}>{emoji}</button>)}</div>}
      </div>

      {tool === "text" && <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <label className="block text-[10px] font-bold text-stone-600">النص على الصورة<textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={180} rows={2} placeholder="اكتب النص هنا..." className="mt-1 w-full resize-y rounded-lg border border-stone-200 px-3 py-2 text-sm leading-6 outline-none focus:border-amber-400" /></label>
        <label className="block text-[10px] font-bold text-stone-600">الموضع<select value={textPosition} onChange={(event) => setTextPosition(event.target.value as typeof textPosition)} className="mt-1 h-10 w-full rounded-lg border border-stone-200 bg-white px-2 text-xs sm:w-28"><option value="top">أعلى</option><option value="center">وسط</option><option value="bottom">أسفل</option></select></label>
        <div className="flex gap-2 sm:flex-col"><label className="block flex-1 text-[10px] font-bold text-stone-600">الحجم<select value={textSize} onChange={(event) => setTextSize(Number(event.target.value))} className="mt-1 h-10 w-full rounded-lg border border-stone-200 bg-white px-2 text-xs"><option value={0.04}>صغير</option><option value={0.06}>متوسط</option><option value={0.085}>كبير</option></select></label><label className="block flex-1 text-[10px] font-bold text-stone-600">اللون<select value={textColor} onChange={(event) => setTextColor(event.target.value as typeof textColor)} className="mt-1 h-10 w-full rounded-lg border border-stone-200 bg-white px-2 text-xs"><option value="white">أبيض</option><option value="black">أسود</option></select></label></div>
      </div>}

      <div className="soft-scroll flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-xl bg-stone-950 p-2 sm:p-3">
        <div className="relative inline-block max-h-[55dvh] max-w-full touch-none select-none" onPointerDown={beginGesture} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={endGesture}>
          <img ref={imageRef} src={url} alt="الصورة الجاري تعديلها" draggable={false} className="block max-h-[55dvh] max-w-full object-contain" />
          <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
            <defs><marker id="image-editor-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="0.035" markerHeight="0.035" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
            {[...annotations, ...(draft ? [draft] : [])].map((item) => item.kind === "pen" ? <polyline key={item.id} points={item.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={item.color} strokeWidth={item.width} strokeLinecap="round" strokeLinejoin="round" /> : item.kind === "shape" ? item.shape === "arrow" ? <line key={item.id} x1={item.from.x} y1={item.from.y} x2={item.to.x} y2={item.to.y} stroke={item.color} strokeWidth={item.width} markerEnd="url(#image-editor-arrowhead)" style={{ color: item.color }} /> : item.shape === "rect" ? <rect key={item.id} x={Math.min(item.from.x, item.to.x)} y={Math.min(item.from.y, item.to.y)} width={Math.abs(item.to.x - item.from.x)} height={Math.abs(item.to.y - item.from.y)} fill="none" stroke={item.color} strokeWidth={item.width} /> : <ellipse key={item.id} cx={(item.from.x + item.to.x) / 2} cy={(item.from.y + item.to.y) / 2} rx={Math.abs(item.to.x - item.from.x) / 2} ry={Math.abs(item.to.y - item.from.y) / 2} fill="none" stroke={item.color} strokeWidth={item.width} /> : <text key={item.id} x={item.point.x} y={item.point.y} textAnchor="middle" dominantBaseline="central" fontSize={item.size} fontFamily="sans-serif">{item.emoji}</text>)}
          </svg>
          {cropEnabled && <div aria-hidden="true" className="pointer-events-none absolute border-2 border-amber-400 shadow-[0_0_0_9999px_rgba(0,0,0,.4)]" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}><span className="absolute -bottom-2 -right-2 h-5 w-5 rounded-br-md border-b-4 border-r-4 border-amber-400" /></div>}
          {text.trim() && <div aria-hidden="true" className={`pointer-events-none absolute flex justify-center px-2 ${textPositionClass}`} style={{ left: `${cropArea.x * 100}%`, top: textPosition === "top" ? `${cropArea.y * 100}%` : textPosition === "center" ? `${(cropArea.y + cropArea.height / 2) * 100}%` : undefined, bottom: textPosition === "bottom" ? `${(1 - cropArea.y - cropArea.height) * 100}%` : undefined, width: `${cropArea.width * 100}%`, transform: textPosition === "center" ? "translateY(-50%)" : undefined }}><span className={`max-w-full whitespace-pre-wrap break-words rounded-md px-2 py-1 text-center font-bold shadow ${textColor === "white" ? "bg-black/60 text-white" : "bg-white/80 text-stone-950"}`} style={{ fontSize: "clamp(12px, 3vw, 22px)" }}>{text}</span></div>}
        </div>
      </div>
      {tool === "crop" && cropEnabled && <p className="mt-2 text-[10px] text-stone-500">اسحب على الصورة لتحديد مساحة القص. اترك الإطار كاملًا لإرسال الصورة دون قص.</p>}
      {tool === "sticker" && <p className="mt-2 text-[10px] text-stone-500">اختر ملصقًا ثم انقر موضعه على الصورة.</p>}
      {tool === "shape" && <p className="mt-2 text-[10px] text-stone-500">اسحب على الصورة لرسم الشكل المختار.</p>}
      {tool === "pen" && <p className="mt-2 text-[10px] text-stone-500">اسحب بإصبعك أو الفأرة للرسم الحر.</p>}
      <footer className="mt-3 flex flex-wrap items-center justify-between gap-2"><button type="button" disabled={!annotations.length && !text.trim()} onClick={() => { setAnnotations([]); setDraft(null); setText(""); }} className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-[10px] font-bold text-stone-600 disabled:opacity-40">مسح التعديلات</button><div className="flex gap-2"><button type="button" onClick={onCancel} className="rounded-lg bg-stone-100 px-4 py-2 text-xs font-bold text-stone-600">إلغاء</button><button type="button" disabled={busy} onClick={() => void saveImage()} className="rounded-lg bg-[#d32f2f] px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{busy ? "جارٍ تجهيز الصورة..." : "استخدام الصورة"}</button></div></footer>
    </section>
  </div>;
}
