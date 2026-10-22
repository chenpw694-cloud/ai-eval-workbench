/** Original image pixels become CSS pixels at scale 1. Pan is relative to the stage centre. */
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type ImageView = Point & { scale: number };

const maximumScale = 8;
const minimumOriginalScale = 0.25;

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function positive(value: number, name: string): void {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function fitScale(stage: Size, image: Size): number {
  positive(stage.width, 'stage.width');
  positive(stage.height, 'stage.height');
  positive(image.width, 'image.width');
  positive(image.height, 'image.height');
  const scale = Math.min(stage.width / image.width, stage.height / image.height, 1);
  positive(scale, 'fit scale');
  return scale;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function panLimit(imageLength: number, stageLength: number, scale: number): number {
  // Divide before multiplying to retain a finite boundary for very large dimensions.
  return Math.min(Number.MAX_VALUE, Math.max(0, imageLength / 2 * scale - stageLength / 2));
}

/** Fit within the available stage, keeping small images at their native size. */
export function fitView(stage: Size, image: Size): ImageView {
  return { scale: fitScale(stage, image), x: 0, y: 0 };
}

/** Limit magnification and keep a zoomed image from being dragged past its edges. */
export function constrainView(view: ImageView, stage: Size, image: Size): ImageView {
  const minimumScale = Math.min(fitScale(stage, image), minimumOriginalScale);
  positive(view.scale, 'view.scale');
  finite(view.x, 'view.x');
  finite(view.y, 'view.y');
  const scale = clamp(view.scale, minimumScale, maximumScale);
  const limitX = panLimit(image.width, stage.width, scale);
  const limitY = panLimit(image.height, stage.height, scale);
  return { scale, x: limitX ? clamp(view.x, -limitX, limitX) : 0, y: limitY ? clamp(view.y, -limitY, limitY) : 0 };
}

/** Zoom around a pointer measured from the stage centre, then apply pan bounds. */
export function zoomView(view: ImageView, nextScale: number, point: Point, stage: Size, image: Size): ImageView {
  const current = constrainView(view, stage, image);
  positive(nextScale, 'nextScale');
  finite(point.x, 'point.x');
  finite(point.y, 'point.y');
  const scale = clamp(nextScale, Math.min(fitScale(stage, image), minimumOriginalScale), maximumScale);
  if (scale === current.scale) return current;
  const ratio = scale / current.scale;
  const x = point.x - (point.x - current.x) * ratio;
  const y = point.y - (point.y - current.y) * ratio;
  finite(x, 'zoom.x');
  finite(y, 'zoom.y');
  return constrainView({ scale, x, y }, stage, image);
}

/** Convert WheelEvent delta units to CSS pixels before applying a zoom ratio. */
export function wheelDeltaPixels(deltaY: number, deltaMode: number, pageHeight: number): number {
  finite(deltaY, 'deltaY');
  positive(pageHeight, 'pageHeight');
  if (deltaMode !== 0 && deltaMode !== 1 && deltaMode !== 2) throw new RangeError('deltaMode must be 0, 1 or 2');
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
  finite(pixels, 'wheel delta');
  return pixels;
}
