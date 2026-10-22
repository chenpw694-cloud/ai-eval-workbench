import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { constrainView, fitView, wheelDeltaPixels, zoomView } from '../core/imageViewport';
import type { ImageView, Size } from '../core/imageViewport';
import './image-inspector.css';

type Props = { src: string; alt: string; info: string };
const emptySize: Size = { width: 0, height: 0 };

export default function ImageInspector({ src, alt, info }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const metrics = useRef({ stage: emptySize, image: emptySize });
  const fitted = useRef(true);
  const current = useRef<ImageView>({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ id: number; startX: number; startY: number; view: ImageView } | null>(null);
  const [view, setView] = useState(current.current);
  const [natural, setNatural] = useState(emptySize);
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(false);

  function update(next: ImageView) {
    current.current = next;
    setView(next);
  }

  function measure() {
    const stage = stageRef.current;
    if (!stage || !stage.clientWidth || !stage.clientHeight || !metrics.current.image.width) return;
    metrics.current.stage = { width: stage.clientWidth, height: stage.clientHeight };
    const { image, stage: size } = metrics.current;
    update(fitted.current ? fitView(size, image) : constrainView(current.current, size, image));
    setReady(true);
  }

  function reset() {
    const { stage, image } = metrics.current;
    if (!stage.width || !image.width) return;
    fitted.current = true;
    update(fitView(stage, image));
  }

  function zoomTo(scale: number, point = { x: 0, y: 0 }) {
    const { stage, image } = metrics.current;
    if (!stage.width || !image.width || !Number.isFinite(scale)) return;
    fitted.current = false;
    update(zoomView(current.current, scale, point, stage, image));
  }

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (drag.current || !metrics.current.image.width || !Number.isFinite(event.deltaY)) return;
      const bounds = stage.getBoundingClientRect();
      const delta = wheelDeltaPixels(event.deltaY, event.deltaMode, bounds.height);
      const factor = Math.exp(-Math.max(-240, Math.min(240, delta)) * (event.ctrlKey ? .01 : .002));
      zoomTo(current.current.scale * factor, { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 });
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); stage.removeEventListener('wheel', wheel); };
  }, []);

  const canPan = ready && (natural.width * view.scale > metrics.current.stage.width + 1 || natural.height * view.scale > metrics.current.stage.height + 1);
  const minimum = ready ? Math.min(fitView(metrics.current.stage, natural).scale, .25) : .25;

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || !ready) return;
    event.currentTarget.focus({ preventScroll: true });
    if (!canPan) return;
    event.preventDefault();
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, view: { ...current.current } };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const { stage, image } = metrics.current;
    update(constrainView({ ...start.view, x: start.view.x + event.clientX - start.startX, y: start.view.y + event.clientY - start.startY }, stage, image));
  }

  function stopDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!ready || event.altKey || event.metaKey || event.ctrlKey) return;
    const offsets: Record<string, [number, number]> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
    if (offsets[event.key]) {
      event.preventDefault();
      fitted.current = false;
      const [x, y] = offsets[event.key];
      update(constrainView({ ...current.current, x: current.current.x + x, y: current.current.y + y }, metrics.current.stage, metrics.current.image));
    } else if (['+', '=', '-', '0', '1'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0') reset();
      else zoomTo(event.key === '1' ? 1 : current.current.scale * (event.key === '-' ? 1 / 1.25 : 1.25));
    }
  }

  return <div className="image-inspector">
    <div className="image-inspector-toolbar" role="group" aria-label="原图缩放工具">
      <button disabled={!ready || view.scale <= minimum + .00001} onClick={() => zoomTo(current.current.scale / 1.25)} aria-label="缩小原图" title="缩小（−）"><ZoomOut size={17} /></button>
      <output aria-label="缩放比例">{ready ? `${Math.round(view.scale * 100)}%` : '—'}</output>
      <button disabled={!ready || view.scale >= 8} onClick={() => zoomTo(current.current.scale * 1.25)} aria-label="放大原图" title="放大（+）"><ZoomIn size={17} /></button>
      <span className="image-inspector-divider" />
      <button disabled={!ready} onClick={() => zoomTo(1)} title="按原始像素显示（1）" aria-label="原始大小（100%）">1:1</button>
      <button disabled={!ready} onClick={reset} title="重置并适应窗口（0）"><RotateCcw size={14} />重置</button>
    </div>
    <div ref={stageRef} className={`image-inspector-stage${canPan ? ' can-pan' : ''}${dragging ? ' dragging' : ''}`} role="region" aria-label="原图缩放查看区域" tabIndex={0} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={() => { drag.current = null; setDragging(false); }} onKeyDown={keyDown} onDoubleClick={event => {
      if (!ready) return;
      const fit = fitView(metrics.current.stage, metrics.current.image);
      if (Math.abs(current.current.scale - fit.scale) > .001) reset();
      else {
        const bounds = event.currentTarget.getBoundingClientRect();
        zoomTo(Math.max(1, fit.scale * 2), { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 });
      }
    }}>
      <img src={src} alt={alt} draggable={false} onLoad={event => {
        const image = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
        metrics.current.image = image;
        setNatural(image);
        fitted.current = true;
        setError(false);
        measure();
      }} onError={() => { setError(true); setReady(false); }} style={{ width: natural.width || undefined, height: natural.height || undefined, opacity: ready ? 1 : 0, transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
      {!ready && <p className="image-inspector-message" role="status">{error ? '图片无法读取，请关闭后重试。' : '正在读取原图…'}</p>}
    </div>
    <p className="image-inspector-help">{info}<span>滚轮缩放 · 放大后拖动查看 · 双击放大 / 还原</span></p>
  </div>;
}
