import { useRef, useEffect, useState, useCallback } from 'react';
import type { WindowLevel, MeasurementTool, Measurement } from './MedicalImageViewer';
import { Slider } from './ui/slider';
import { getSnapPoints, findNearestSnap, drawSnapIndicator, SnapPoint } from './utils/snapPoints';

interface ViewportProps {
  imageData: Uint8Array;
  header: any;
  plane: 'axial' | 'sagittal' | 'coronal';
  currentSlice: number;
  onSliceChange: (slice: number) => void;
  windowLevel: WindowLevel;
  onWindowLevelChange: (wl: WindowLevel) => void;
  activeTool: MeasurementTool;
  measurements: Measurement[];
  onMeasurementAdd: (measurement: Measurement) => void;
  onMeasurementUpdate: (id: string, newPoints: { x: number; y: number }[]) => void;
  applyWeighting: (pixelValue: number) => number;
  showCrosshair?: boolean;
  parentWindowHeight?: number;
}

export function Viewport({
  imageData,
  header,
  plane,
  currentSlice,
  onSliceChange,
  windowLevel,
  onWindowLevelChange,
  activeTool,
  measurements,
  onMeasurementAdd,
  onMeasurementUpdate,
  applyWeighting,
  showCrosshair = false,
  parentWindowHeight,
}: ViewportProps) {
  const [autoFlash, setAutoFlash] = useState<{ window: number; level: number } | null>(null);
  const [draggingPoint, setDraggingPoint] = useState<{ measurementId: string; pointIndex: number } | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const draggingPointRef = useRef<{ measurementId: string; pointIndex: number } | null>(null);
  const measurementsRef = useRef(measurements);
  useEffect(() => { measurementsRef.current = measurements; }, [measurements]);
  const [activeSnap, setActiveSnap] = useState<SnapPoint | null>(null);
  const activeSnapRef = useRef<SnapPoint | null>(null);

  useEffect(() => {
    if (!windowLevel) return;
    setAutoFlash({ window: Math.round(windowLevel.window), level: Math.round(windowLevel.level) });
    const id = setTimeout(() => setAutoFlash(null), 1200);
    return () => clearTimeout(id);
  }, [windowLevel]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  // container for responsive sizing
  const containerRef = useRef<HTMLDivElement>(null);
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const displaySizeRef = useRef(displaySize);
  // for debugging: container rect seen by ResizeObserver
  const [containerRect, setContainerRect] = useState({ width: 0, height: 0 });
  const [ancestorRects, setAncestorRects] = useState<{ parent: { width: number; height: number } | null; grandParent: { width: number; height: number } | null }>({ parent: null, grandParent: null });
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState<{ x: number; y: number }[]>([]);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  // Pan state
  const [panSrc, setPanSrc] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const panStartRef = useRef<{ clientX: number; clientY: number; startX: number; startY: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [axialTransform, setAxialTransform] = useState<{ rotation: number }>({
    rotation: 0,
  });
  const [isRotateMode, setIsRotateMode] = useState(false);
  const [isZoomMode, setIsZoomMode] = useState(false);
  /** Last pointer over the overlay (for wheel focal when clientX/Y on wheel is unreliable). */
  const lastPointerClientRef = useRef<{ x: number; y: number } | null>(null);
  const zoomScaleRef = useRef(zoomScale);
  const panSrcRef = useRef(panSrc);
  useEffect(() => {
    zoomScaleRef.current = zoomScale;
    panSrcRef.current = panSrc;
  }, [zoomScale, panSrc]);
  const rotateDragRef = useRef<{ dragging: boolean; startAngle: number; startRotation: number }>({
    dragging: false,
    startAngle: 0,
    startRotation: 0,
  });
  const sliceDimsRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const cropRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const isAxial = plane === 'axial';
  const normalizeAngle = useCallback((angle: number) => {
    return ((angle % 360) + 360) % 360;
  }, []);

  const getPlaneGeometry = useCallback(() => {
    const dims = header.dims;
    const pixDims = header.pixDims || header?.pixdim || [];
    const width = plane === 'sagittal' ? dims[2] : dims[1];
    const height = plane === 'axial' ? dims[2] : dims[3];

    const p1 = Number.isFinite(pixDims[1]) && pixDims[1] > 0 ? pixDims[1] : 1;
    const p2 = Number.isFinite(pixDims[2]) && pixDims[2] > 0 ? pixDims[2] : 1;
    /** In-plane voxel pitch (typical MRI: ~0.5–1 mm, matrix often 512×512). */
    const dInPlane = Math.min(p1, p2);

    let spacingX: number;
    let spacingY: number;
    if (plane === 'axial') {
      spacingX = p1;
      spacingY = p2;
    } else if (plane === 'coronal') {
      // Horizontal = x (same as axial width). Vertical = through-plane (z). Using true dz here
      // often stretches anatomy because slice spacing ≫ in-plane spacing; match in-plane pitch so
      // MPR matches the familiar 512×512-style square voxels on screen.
      spacingX = p1;
      spacingY = dInPlane;
    } else {
      // sagittal: horizontal = y, vertical = z
      spacingX = p2;
      spacingY = dInPlane;
    }

    return { width, height, spacingX, spacingY };
  }, [header, plane]);



  // Get slice data based on orientation
  const getSliceData = useCallback(() => {
    const dims = header.dims;
    const { width, height } = getPlaneGeometry();
    const sliceSize = width * height;
    const sliceData = new Uint8Array(sliceSize);

    // Extract slice based on plane
    if (plane === 'axial') {
      const offset = currentSlice * dims[1] * dims[2];
      for (let i = 0; i < sliceSize; i++) {
        sliceData[i] = imageData[offset + i] || 0;
      }
    } else if (plane === 'sagittal') {
      for (let z = 0; z < dims[3]; z++) {
        for (let y = 0; y < dims[2]; y++) {
          const idx = z * dims[2] + y;
          const sourceIdx = z * dims[1] * dims[2] + y * dims[1] + currentSlice;
          sliceData[idx] = imageData[sourceIdx] || 0;
        }
      }
    } else { // coronal
      for (let z = 0; z < dims[3]; z++) {
        for (let x = 0; x < dims[1]; x++) {
          const idx = z * dims[1] + x;
          const sourceIdx = z * dims[1] * dims[2] + currentSlice * dims[1] + x;
          sliceData[idx] = imageData[sourceIdx] || 0;
        }
      }
    }

    return { sliceData, width, height };
  }, [imageData, header, plane, currentSlice, getPlaneGeometry]);

  // ResizeObserver to calculate fit-to-container display size while preserving aspect ratio
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      const rect = container.getBoundingClientRect();
      // store rect for debugging
      setContainerRect({ width: Math.round(rect.width), height: Math.round(rect.height) });

      // also capture parent chain sizes to find where height is constrained
      const parent = container.parentElement;
      const parentRect = parent?.getBoundingClientRect();
      const grandParentRect = parent?.parentElement?.getBoundingClientRect();
      setAncestorRects({
        parent: parentRect ? { width: Math.round(parentRect.width), height: Math.round(parentRect.height) } : null,
        grandParent: grandParentRect ? { width: Math.round(grandParentRect.width), height: Math.round(grandParentRect.height) } : null,
      });

      if (rect.width === 0 || rect.height === 0) {
        setDisplaySize({ width: 0, height: 0 });
        return;
      }

      // Compute available size from the container rect (for floating windows this avoids using the full window size)
      let sliderWidth = 0;
      let sliderMarginLeft = 0;
      const sliderEl = sliderRef.current;
      if (sliderEl) {
        const sRect = sliderEl.getBoundingClientRect();
        sliderWidth = Math.round(sRect.width);
        const sStyle = window.getComputedStyle(sliderEl);
        sliderMarginLeft = parseFloat(sStyle.marginLeft || '0') || 0;
      }

      // Rebuilt fit algorithm (aspect-preserving, deterministic)
      const paddingBuffer = 8;
      const { width: imgW, height: imgH, spacingX, spacingY } = getPlaneGeometry();
      const physicalW = imgW * spacingX;
      const physicalH = imgH * spacingY;

      // Available area inside the container (subtract slider if present)
      const availW = Math.max(1, rect.width - sliderWidth - sliderMarginLeft - paddingBuffer * 2);
      const availH = Math.max(1, rect.height - paddingBuffer * 2);

      // If image has invalid dimensions, fallback to small default
      const safeImgW = Math.max(1, imgW || 1);
      const safeImgH = Math.max(1, imgH || 1);

      // Compute scale so image fits into the available area using the smaller dimension
      // (allow upscaling so the image can fill the smaller container dimension)
      const safePhysicalW = Math.max(1, physicalW || 1);
      const safePhysicalH = Math.max(1, physicalH || 1);
      const scale = Math.min(availW / safePhysicalW, availH / safePhysicalH);
      const computedW = Math.max(1, Math.round(safePhysicalW * scale));
      const computedH = Math.max(1, Math.round(safePhysicalH * scale));

      // Enforce sensible min / max so the wrapper never collapses
      const MIN_DISPLAY = 48; // absolute lower bound
      const maxW = Math.max(MIN_DISPLAY, Math.round(rect.width - paddingBuffer * 2));
      const maxH = Math.max(MIN_DISPLAY, Math.round(rect.height - paddingBuffer * 2));

      const finalW = Math.max(MIN_DISPLAY, Math.min(maxW, Math.round(computedW)));
      const finalH = Math.max(MIN_DISPLAY, Math.min(maxH, Math.round(computedH)));

      // Adaptive hysteresis based on the container size to avoid micro updates
      const deltaW = Math.max(2, Math.round(rect.width * 0.005));
      const deltaH = Math.max(2, Math.round(rect.height * 0.005));
      if (Math.abs(displaySizeRef.current.width - finalW) < deltaW && Math.abs(displaySizeRef.current.height - finalH) < deltaH) {
        return;
      }

      // Debug trace (left intentionally minimal)
      console.debug('fit', { rectW: rect.width, rectH: rect.height, availW, availH, imgW: safeImgW, imgH: safeImgH, physicalW: safePhysicalW, physicalH: safePhysicalH, finalW, finalH });

      displaySizeRef.current = { width: finalW, height: finalH };
      setDisplaySize({ width: finalW, height: finalH });
    };

    // Debounced ResizeObserver + rAF to avoid reacting to rapid micro-changes
    let rafId: number | null = null;
    const debouncedUpdate = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        update();
      });
    };

    const ro = new ResizeObserver(debouncedUpdate);
    ro.observe(container);

    const onResize = () => debouncedUpdate();
    const onScroll = () => debouncedUpdate();

    window.addEventListener('resize', onResize);
    // use capture to catch scrolls from ancestors
    window.addEventListener('scroll', onScroll, true);

    // run once immediately
    update();

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
  }, [getPlaneGeometry]);

  // Apply window/level and weighting to image
  const applyWindowLevel = useCallback((value: number): number => {
    // Apply weighting first
    const weighted = applyWeighting(value);
    
    // Then apply window/level
    const { window, level } = windowLevel;
    const min = level - window / 2;
    const max = level + window / 2;
    
    if (weighted <= min) return 0;
    if (weighted >= max) return 255;
    
    return Math.round(((weighted - min) / window) * 255);
  }, [windowLevel, applyWeighting]);

  const drawTransformedImage = useCallback((
    ctx: CanvasRenderingContext2D,
    dpr: number,
    centerX: number,
    centerY: number,
    drawW: number,
    drawH: number,
    drawImage: () => void
  ) => {
    const rotation = isAxial ? normalizeAngle(axialTransform.rotation) : 0;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(centerX, centerY);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-drawW / 2, -drawH / 2);
    drawImage();
    ctx.restore();
  }, [isAxial, axialTransform, normalizeAngle]);

  const rotateAxialBy = useCallback((delta: number) => {
    setAxialTransform(prev => ({ rotation: normalizeAngle(prev.rotation + delta) }));
  }, [normalizeAngle]);

  const getPointerAngleFromCenter = useCallback((clientX: number, clientY: number) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    return Math.atan2(clientY - centerY, clientX - centerX) * (180 / Math.PI);
  }, []);

  const startRotateDrag = useCallback((clientX: number, clientY: number) => {
    rotateDragRef.current = {
      dragging: true,
      startAngle: getPointerAngleFromCenter(clientX, clientY),
      startRotation: axialTransform.rotation,
    };
  }, [axialTransform.rotation, getPointerAngleFromCenter]);

  const moveRotateDrag = useCallback((clientX: number, clientY: number) => {
    const drag = rotateDragRef.current;
    if (!drag.dragging) return;
    const currentAngle = getPointerAngleFromCenter(clientX, clientY);
    let delta = currentAngle - drag.startAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    const nextRotation = normalizeAngle(drag.startRotation + delta);
    setAxialTransform({ rotation: nextRotation });
  }, [normalizeAngle, getPointerAngleFromCenter]);

  const stopRotateDrag = useCallback(() => {
    rotateDragRef.current.dragging = false;
  }, []);

  /** Map screen position to slice image pixel (continuous) for current zoom/pan/rotation. */
  const clientToImagePixel = useCallback(
    (clientX: number, clientY: number): { imgX: number; imgY: number } | null => {
      const main = canvasRef.current;
      if (!main) return null;
      const rect = main.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const displayW_css = main.width / dpr;
      const displayH_css = main.height / dpr;
      if (displayW_css < 1 || displayH_css < 1) return null;
      const lx = ((clientX - rect.left) / Math.max(rect.width, 1)) * displayW_css;
      const ly = ((clientY - rect.top) / Math.max(rect.height, 1)) * displayH_css;

      const iw = sliceDimsRef.current.w;
      const ih = sliceDimsRef.current.h;
      if (iw < 1 || ih < 1) return null;

      const { spacingX, spacingY } = getPlaneGeometry();
      const physicalW = iw * spacingX;
      const physicalH = ih * spacingY;
      const sx = displayW_css / physicalW || 1;
      const sy = displayH_css / physicalH || 1;
      const scaleFit = Math.min(sx, sy);
      const drawW = Math.max(1, Math.round(physicalW * scaleFit));
      const drawH = Math.max(1, Math.round(physicalH * scaleFit));

      const cx = displayW_css / 2;
      const cy = displayH_css / 2;
      const θ = (normalizeAngle(axialTransform.rotation) * Math.PI) / 180;
      const rx = lx - cx;
      const ry = ly - cy;
      const ix = Math.cos(-θ) * rx - Math.sin(-θ) * ry;
      const iy = Math.sin(-θ) * rx + Math.cos(-θ) * ry;
      let u = ix + drawW / 2;
      let v = iy + drawH / 2;
      u = Math.max(0, Math.min(drawW, u));
      v = Math.max(0, Math.min(drawH, v));
      const uFrac = drawW > 0 ? u / drawW : 0.5;
      const vFrac = drawH > 0 ? v / drawH : 0.5;

      const z = zoomScaleRef.current;
      const cropW = Math.max(1, Math.floor(iw / z));
      const cropH = Math.max(1, Math.floor(ih / z));
      const px = Math.max(0, Math.min(iw - cropW, Math.round(panSrcRef.current.x)));
      const py = Math.max(0, Math.min(ih - cropH, Math.round(panSrcRef.current.y)));
      return {
        imgX: px + uFrac * cropW,
        imgY: py + vFrac * cropH,
      };
    },
    [getPlaneGeometry, normalizeAngle, axialTransform.rotation]
  );

  /** Axial zoom mode: zoom toward whatever is under the pointer (hover + scroll). */
  const applyAxialWheelZoomAtPointer = useCallback(
    (clientX: number, clientY: number, deltaY: number, deltaMode: number) => {
      const iw = sliceDimsRef.current.w;
      const ih = sliceDimsRef.current.h;
      if (iw < 1 || ih < 1) return;

      const main = canvasRef.current;
      if (main) {
        const r = main.getBoundingClientRect();
        const inside =
          clientX >= r.left &&
          clientX <= r.right &&
          clientY >= r.top &&
          clientY <= r.bottom;
        if (!inside && lastPointerClientRef.current) {
          clientX = lastPointerClientRef.current.x;
          clientY = lastPointerClientRef.current.y;
        }
      }

      let focal = clientToImagePixel(clientX, clientY);
      if (!focal && lastPointerClientRef.current) {
        focal = clientToImagePixel(lastPointerClientRef.current.x, lastPointerClientRef.current.y);
      }

      const prevZ = zoomScaleRef.current;
      let step = deltaY;
      if (deltaMode === 1) step *= 16;
      if (deltaMode === 2) step *= 800;
      const factor = Math.exp(-step * 0.0012);
      const newZ = Math.min(20, Math.max(1, prevZ * factor));
      if (Math.abs(newZ - prevZ) < 1e-6) return;

      if (newZ <= 1) {
        zoomScaleRef.current = 1;
        panSrcRef.current = { x: 0, y: 0 };
        setZoomScale(1);
        setPanSrc({ x: 0, y: 0 });
        return;
      }

      const cropW = Math.max(1, Math.floor(iw / prevZ));
      const cropH = Math.max(1, Math.floor(ih / prevZ));
      const px = Math.max(0, Math.min(iw - cropW, Math.round(panSrcRef.current.x)));
      const py = Math.max(0, Math.min(ih - cropH, Math.round(panSrcRef.current.y)));

      let uFrac = 0.5;
      let vFrac = 0.5;
      if (focal) {
        uFrac = cropW > 0 ? (focal.imgX - px) / cropW : 0.5;
        vFrac = cropH > 0 ? (focal.imgY - py) / cropH : 0.5;
        uFrac = Math.max(0, Math.min(1, uFrac));
        vFrac = Math.max(0, Math.min(1, vFrac));
      }

      const imgX = px + uFrac * cropW;
      const imgY = py + vFrac * cropH;

      const newCropW = Math.max(1, Math.floor(iw / newZ));
      const newCropH = Math.max(1, Math.floor(ih / newZ));
      let npx = Math.round(imgX - uFrac * newCropW);
      let npy = Math.round(imgY - vFrac * newCropH);
      npx = Math.max(0, Math.min(iw - newCropW, npx));
      npy = Math.max(0, Math.min(ih - newCropH, npy));

      zoomScaleRef.current = newZ;
      panSrcRef.current = { x: npx, y: npy };
      setZoomScale(newZ);
      setPanSrc({ x: npx, y: npy });
    },
    [clientToImagePixel]
  );

  // Keep axial starting orientation neutral and centered when loading new image data.
  useEffect(() => {
    if (!isAxial) return;
    setAxialTransform({ rotation: 0 });
    zoomScaleRef.current = 1;
    panSrcRef.current = { x: 0, y: 0 };
    setZoomScale(1);
    setPanSrc({ x: 0, y: 0 });
    setIsRotateMode(false);
    setIsZoomMode(false);
    lastPointerClientRef.current = null;
  }, [imageData, isAxial]);

  // Heavy rendering effect: builds source canvas and caches ImageBitmap when slice/WL/weighting changes
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const bitmapKeyRef = useRef<string | null>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const overlay = overlayCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    (async () => {
      const { sliceData, width, height } = getSliceData();

      // Track slice dimensions for pan calculations
      sliceDimsRef.current = { w: width, h: height };

      // Build RGBA image buffer after applying window/level
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < sliceData.length; i++) {
        const value = applyWindowLevel(sliceData[i]);
        rgba[i * 4] = value;
        rgba[i * 4 + 1] = value;
        rgba[i * 4 + 2] = value;
        rgba[i * 4 + 3] = 255;
      }

      const imgData = new ImageData(rgba, width, height);

      // Compute display size (CSS pixels)
      const displayW = displaySize.width || width;
      const displayH = displaySize.height || height;

      const dpr = window.devicePixelRatio || 1;

      // Set backing store to match the desired display size in device pixels
      const MAX_BACKING = 8192; // cap to avoid infinite memory growth
      let targetW = Math.max(1, Math.floor(displayW * dpr));
      let targetH = Math.max(1, Math.floor(displayH * dpr));

      // If either dimension exceeds limit, scale down while preserving aspect
      if (targetW > MAX_BACKING || targetH > MAX_BACKING) {
        const scale = Math.min(MAX_BACKING / targetW, MAX_BACKING / targetH);
        targetW = Math.max(1, Math.floor(targetW * scale));
        targetH = Math.max(1, Math.floor(targetH * scale));
      }

      canvas.width = targetW;
      canvas.height = targetH;

      // Scale canvas CSS size to the target display size (CSS pixels)
      canvas.style.width = `${displayW}px`;
      canvas.style.height = `${displayH}px`;

      // Ensure we have a source canvas to draw from synchronously
      if (!sourceCanvasRef.current) sourceCanvasRef.current = document.createElement('canvas');
      const src = sourceCanvasRef.current;
      if (src.width !== width || src.height !== height) {
        src.width = width;
        src.height = height;
      }
      const sctx = src.getContext('2d');
      sctx?.putImageData(imgData, 0, 0);

      // Draw immediately from source canvas (synchronous and fast)
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Compute CSS display sizes (canvas backing divided by DPR)
      const displayW_css = canvas.width / dpr;
      const displayH_css = canvas.height / dpr;

      // compute scaled draw size preserving aspect and centering
      const { spacingX, spacingY } = getPlaneGeometry();
      const physicalW = width * spacingX;
      const physicalH = height * spacingY;
      const sx = displayW_css / physicalW || 1;
      const sy = displayH_css / physicalH || 1;
      const scale = Math.min(sx, sy);
      const drawW = Math.max(1, Math.round(physicalW * scale));
      const drawH = Math.max(1, Math.round(physicalH * scale));
      const centerX = displayW_css / 2;
      const centerY = displayH_css / 2;

      if (zoomScale > 1) {
        const cropW = Math.max(1, Math.floor(width / zoomScale));
        const cropH = Math.max(1, Math.floor(height / zoomScale));
        cropRef.current = { w: cropW, h: cropH };

        const px = Math.max(0, Math.min(sliceDimsRef.current.w - cropW, Math.round(panSrc.x || 0)));
        const py = Math.max(0, Math.min(sliceDimsRef.current.h - cropH, Math.round(panSrc.y || 0)));
        if (panSrc.x !== px || panSrc.y !== py) {
          panSrcRef.current = { x: px, y: py };
          setPanSrc({ x: px, y: py });
        }

        drawTransformedImage(ctx, dpr, centerX, centerY, drawW, drawH, () => {
          ctx.drawImage(src, px, py, cropW, cropH, 0, 0, drawW, drawH);
        });
      } else {
        // draw full image centered and scaled
        drawTransformedImage(ctx, dpr, centerX, centerY, drawW, drawH, () => {
          ctx.drawImage(src, 0, 0, width, height, 0, 0, drawW, drawH);
        });
      }

      // Asynchronously build and cache an ImageBitmap for faster subsequent draws
      const key = `${plane}:${currentSlice}:${windowLevel.window}:${windowLevel.level}`;
      if (bitmapKeyRef.current !== key) {
        try {
          const b = await createImageBitmap(imgData);
          if (cancelled) { b.close?.(); }
          else {
            bitmapRef.current?.close?.();
            bitmapRef.current = b;
            bitmapKeyRef.current = key;
          }
        } catch (e) {
          // ignore
        }
      }

      // Ensure overlay canvas matches backing store and CSS size
      if (overlay) {
        overlay.width = canvas.width;
        overlay.height = canvas.height;
        overlay.style.width = `${displayW}px`;
        overlay.style.height = `${displayH}px`;
      }
    })();

    return () => { cancelled = true; };
  }, [imageData, currentSlice, plane, windowLevel, applyWindowLevel, getSliceData, getPlaneGeometry, displaySize, zoomScale, panSrc, drawTransformedImage]);

  // Fast pan/zoom draw effect: responds to panSrc and zoomScale without rebuilding pixels
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const src = sourceCanvasRef.current;
    if (!src) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const width = src.width;
    const height = src.height;

    const dpr = window.devicePixelRatio || 1;
    const displayW_css = canvas.width / dpr;
    const displayH_css = canvas.height / dpr;
    const { spacingX, spacingY } = getPlaneGeometry();
    const physicalW = width * spacingX;
    const physicalH = height * spacingY;
    const sx = displayW_css / physicalW || 1;
    const sy = displayH_css / physicalH || 1;
    const scale = Math.min(sx, sy);
    const drawW = Math.max(1, Math.round(physicalW * scale));
    const drawH = Math.max(1, Math.round(physicalH * scale));
    const centerX = displayW_css / 2;
    const centerY = displayH_css / 2;

    if (zoomScale > 1) {
      const cropW = Math.max(1, Math.floor(width / zoomScale));
      const cropH = Math.max(1, Math.floor(height / zoomScale));
      cropRef.current = { w: cropW, h: cropH };

      const px = Math.max(0, Math.min(sliceDimsRef.current.w - cropW, Math.round(panSrc.x || 0)));
      const py = Math.max(0, Math.min(sliceDimsRef.current.h - cropH, Math.round(panSrc.y || 0)));

      drawTransformedImage(ctx, dpr, centerX, centerY, drawW, drawH, () => {
        ctx.drawImage(src, px, py, cropW, cropH, 0, 0, drawW, drawH);
      });
    } else {
      drawTransformedImage(ctx, dpr, centerX, centerY, drawW, drawH, () => {
        ctx.drawImage(src, 0, 0, width, height, 0, 0, drawW, drawH);
      });
    }
  }, [panSrc, zoomScale, displaySize, getPlaneGeometry, drawTransformedImage, axialTransform.rotation]);

  // Render measurements overlay
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    const mainCanvas = canvasRef.current;
    if (!canvas || !mainCanvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    // Match internal pixel dimensions of main canvas
    canvas.width = mainCanvas.width;
    canvas.height = mainCanvas.height;

    // Scale context so drawing uses CSS pixel coords
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear in CSS pixel coordinates
    const clearW = canvas.width / dpr;
    const clearH = canvas.height / dpr;
    ctx.clearRect(0, 0, clearW, clearH);

    // Draw crosshair (optional)
    if (showCrosshair) {
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      const centerX = clearW / 2;
      const centerY = clearH / 2;
      
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(centerX, clearH);
      ctx.moveTo(0, centerY);
      ctx.lineTo(clearW, centerY);
      ctx.stroke();
    }

    // Draw completed measurements
    measurementsRef.current.forEach((measurement) => {
      ctx.strokeStyle = '#FFD700';
      ctx.fillStyle = '#FFD700';
      ctx.lineWidth = 1;

      const points = measurement.points;

      if (measurement.type === 'distance' && points.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
        
        // Draw endpoints
        points.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });


        const midX = (points[0].x + points[1].x) / 2;
        const midY = (points[0].y + points[1].y) / 2;
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px sans-serif';
        ctx.fillText(measurement.value || '', midX + 5, midY - 5);
        ctx.fillStyle = '#FFD700';
        if (measurement.id === selectedLineId) {
          const midX = (points[0].x + points[1].x) / 2;
          const midY = (points[0].y + points[1].y) / 2;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(midX - 12, midY - 12, 24, 24);
          ctx.fillStyle = '#000000';
          ctx.font = 'bold 14px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('⊥', midX, midY);
          ctx.fillStyle = '#FFD700';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
        }


      } else if (measurement.type === 'angle' && points.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.lineTo(points[2].x, points[2].y);
        ctx.stroke();
        
        points.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });

        ctx.fillStyle = '#ffffff';
        ctx.font = '12px sans-serif';
        ctx.fillText(measurement.value || '', points[1].x + 8, points[1].y - 8);
        ctx.fillStyle = '#FFD700';

        } else if (measurement.type === 'perpendicular' && points.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);
          ctx.lineTo(points[1].x, points[1].y);
          ctx.stroke();
  
          // Draw draggable tip
          ctx.fillStyle = '#00FF7F';
          ctx.beginPath();
          ctx.arc(points[0].x, points[0].y, 4, 0, Math.PI * 2);
          ctx.fill();

          // Draw draggable tip
          ctx.fillStyle = '#FFD700';
          ctx.beginPath();
          ctx.arc(points[1].x, points[1].y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
    });

    // Draw snap indicator
    if (activeSnap) {
      drawSnapIndicator(ctx, activeSnap);
    }
    // Draw current drawing
    if (isDrawing && drawingPoints.length > 0) {
      ctx.strokeStyle = '#FFD700';
      ctx.fillStyle = '#FFD700';
      ctx.lineWidth = 1;

      if (activeTool === 'distance' || activeTool === 'line' || activeTool === 'angle') {
        ctx.beginPath();
        ctx.moveTo(drawingPoints[0].x, drawingPoints[0].y);
        drawingPoints.forEach(p => ctx.lineTo(p.x, p.y));
        if (cursorPos) ctx.lineTo(cursorPos.x, cursorPos.y);
        ctx.stroke();
        
        drawingPoints.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }
  }, [measurements, currentSlice, isDrawing, drawingPoints, activeTool, cursorPos, showCrosshair, selectedLineId, activeSnap]);

  // Calculate measurement value
  const calculateMeasurementValue = (type: MeasurementTool, points: { x: number; y: number }[]): string => {
    if (type === 'distance' && points.length === 2) {
      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      return `${dist.toFixed(2)} px`;
    } else if (type === 'angle' && points.length === 3) {
      const v1 = { x: points[0].x - points[1].x, y: points[0].y - points[1].y };
      const v2 = { x: points[2].x - points[1].x, y: points[2].y - points[1].y };
      const dot = v1.x * v2.x + v1.y * v2.y;
      const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
      const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
      const angle = Math.acos(dot / (mag1 * mag2)) * (180 / Math.PI);
      return `${angle.toFixed(1)}°`;
    }
    return '';
  };

  const snapCoord = (x: number, y: number) => ({
    x: activeSnapRef.current?.x ?? x,
    y: activeSnapRef.current?.y ?? y,
  });

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Check if clicking near an existing measurement point
if (activeTool  === 'none') {
  for (const m of measurements) {
    for (let i = 0; i < m.points.length; i++) {
      const p = m.points[i];
      const dist = Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2);
      if (dist < 10) {
        draggingPointRef.current = { measurementId: m.id, pointIndex: i };
        setDraggingPoint({ measurementId: m.id, pointIndex: i });
        setIsDrawing(false);
        setDrawingPoints([]);
        console.log('set dragging point:', draggingPointRef.current);
        return;
      }
    }
  }
  for (const m of measurements) {
  if (m.type !== 'distance') continue;
  if (m.points.length < 2) continue;
  const p0 = m.points[0];
  const p1 = m.points[1];
  // distance from click to line segment
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const lenSq = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x - p0.x) * dx + (y - p0.y) * dy) / lenSq));
  const closestX = p0.x + t * dx;
  const closestY = p0.y + t * dy;
  const dist = Math.sqrt((x - closestX) ** 2 + (y - closestY) ** 2);
  if (dist < 10) {
    setSelectedLineId(m.id);
    return;
  }
}
setSelectedLineId(null);
}

    if (isAxial && isRotateMode) {
      startRotateDrag(e.clientX, e.clientY);
    } else if (activeTool === 'pan') {
      // start panning
      setIsPanning(true);
      panStartRef.current = { clientX: e.clientX, clientY: e.clientY, startX: panSrc.x, startY: panSrc.y };
    } else if (activeTool === 'none') {
    } else if (activeTool === 'point') {
      // Single-click point primitive — emit immediately, no drag phase.
      onMeasurementAdd({
        id: Date.now().toString(),
        type: 'point',
        points: [{ x, y }],
        slice: currentSlice,
        plane,
      });
    } else {
      setIsDrawing(true);
      setDrawingPoints([{ x, y }]);
    }
  };

  const panRafRef = useRef<number | null>(null);

  const drawPanImmediate = (newX: number, newY: number) => {
    const canvas = canvasRef.current;
    const src = sourceCanvasRef.current;
    if (!canvas || !src) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = src.width;
    const height = src.height;

    const displayW_css = canvas.width / dpr;
    const displayH_css = canvas.height / dpr;
    const { spacingX, spacingY } = getPlaneGeometry();
    const physicalW = width * spacingX;
    const physicalH = height * spacingY;
    const sx = displayW_css / physicalW || 1;
    const sy = displayH_css / physicalH || 1;
    const scale = Math.min(sx, sy);
    const drawW = Math.max(1, Math.round(physicalW * scale));
    const drawH = Math.max(1, Math.round(physicalH * scale));
    const centerX = displayW_css / 2;
    const centerY = displayH_css / 2;

    const cropW = Math.max(1, Math.floor(width / zoomScale));
    const cropH = Math.max(1, Math.floor(height / zoomScale));

    // clear then draw
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawTransformedImage(ctx, dpr, centerX, centerY, drawW, drawH, () => {
      ctx.drawImage(src, newX, newY, cropW, cropH, 0, 0, drawW, drawH);
    });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    lastPointerClientRef.current = { x: e.clientX, y: e.clientY };

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (activeTool === 'distance' || activeTool === 'line' || activeTool === 'angle') {
      const snap = findNearestSnap(x, y, getSnapPoints(measurementsRef.current));
      activeSnapRef.current = snap;
      setActiveSnap(snap);
    }

    if (draggingPointRef.current) {
  const m = measurementsRef.current.find(m => m.id === draggingPointRef.current!.measurementId);
  if (m?.type === 'perpendicular' && m.baseLineId) {
    const baseLine = measurementsRef.current.find(b => b.id === m.baseLineId);
    if (baseLine && baseLine.points.length >= 2) {
      const p0 = baseLine.points[0];
      const p1 = baseLine.points[1];
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const perpX = -dy / len;
      const perpY = dx / len;

      if (draggingPointRef.current!.pointIndex === 0) {
        // Drag anchor along the base line
        const t = Math.max(0, Math.min(1, ((x - p0.x) * dx + (y - p0.y) * dy) / (len * len)));
        const anchorX = p0.x + t * dx;
        const anchorY = p0.y + t * dy;
        // Keep stub length and direction
        const stubDx = m.points[1].x - m.points[0].x;
        const stubDy = m.points[1].y - m.points[0].y;
        const stubLen = Math.sqrt(stubDx * stubDx + stubDy * stubDy);
        const sign = (stubDx * perpX + stubDy * perpY) >= 0 ? 1 : -1;
        onMeasurementUpdate(m.id, [
          { x: anchorX, y: anchorY },
          { x: anchorX + perpX * stubLen * sign, y: anchorY + perpY * stubLen * sign },
        ]);
      } else {
        // Drag tip along perpendicular axis from anchor
        const anchorX = m.points[0].x;
        const anchorY = m.points[0].y;
        const t = (x - anchorX) * perpX + (y - anchorY) * perpY;
        onMeasurementUpdate(m.id, [
          { x: anchorX, y: anchorY },
          { x: anchorX + perpX * t, y: anchorY + perpY * t },
        ]);
      }
      return;
    }
  }
    const newMeasurements = measurementsRef.current.map(m => {
      if (m.id !== draggingPointRef.current!.measurementId) return m;
      const newPoints = [...m.points];
      newPoints[draggingPointRef.current!.pointIndex] = { x, y };
      return { ...m, points: newPoints };
    });
    const updated = newMeasurements.find(m => m.id === draggingPointRef.current!.measurementId);
    if (updated) onMeasurementUpdate(updated.id, updated.points);
    return;
}

    if (isAxial && isRotateMode && rotateDragRef.current.dragging) {
      moveRotateDrag(e.clientX, e.clientY);
    } else if (activeTool === 'pan' && isPanning && panStartRef.current) {
      // Calculate image crop size
      const cropW = Math.max(1, Math.floor(sliceDimsRef.current.w / zoomScale));
      const cropH = Math.max(1, Math.floor(sliceDimsRef.current.h / zoomScale));
      const displayW = displaySize.width || sliceDimsRef.current.w;
      const displayH = displaySize.height || sliceDimsRef.current.h;

      const dx = e.clientX - panStartRef.current.clientX;
      const dy = e.clientY - panStartRef.current.clientY;

      const imageDx = Math.round((dx / displayW) * cropW);
      const imageDy = Math.round((dy / displayH) * cropH);

      const newX = Math.max(0, Math.min(sliceDimsRef.current.w - cropW, panStartRef.current.startX - imageDx));
      const newY = Math.max(0, Math.min(sliceDimsRef.current.h - cropH, panStartRef.current.startY - imageDy));

      // Immediate visual update via rAF draw
      if (panRafRef.current != null) cancelAnimationFrame(panRafRef.current);
      panRafRef.current = requestAnimationFrame(() => drawPanImmediate(newX, newY));

      // Still update state for persistence and other effects
      panSrcRef.current = { x: newX, y: newY };
      setPanSrc({ x: newX, y: newY });
    } else if (isDrawing) {
      if (activeTool === 'distance' || activeTool === 'line') {
        const sc = snapCoord(x, y);
        setDrawingPoints([drawingPoints[0], { x: sc.x, y: sc.y }]);
      }
    }
    setCursorPos({ x, y });
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (draggingPointRef.current) {
      draggingPointRef.current = null;
      setDraggingPoint(null);
      return;
}

    if (isAxial && isRotateMode && rotateDragRef.current.dragging) {
      stopRotateDrag();
    }
    if (activeTool === 'pan' && isPanning) {
      setIsPanning(false);
      panStartRef.current = null;
    } else if (isDrawing) {
      if (activeTool === 'distance' || activeTool === 'line') {
        // handled by click
      } else if (activeTool === 'angle') {
        // handled by click
      }
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Check if clicking the ⊥ button on a selected line
    if (activeTool === 'none' && selectedLineId) {
      const baseLine = measurements.find(m => m.id === selectedLineId);
      if (baseLine && baseLine.points.length >= 2) {
        const p0 = baseLine.points[0];
        const p1 = baseLine.points[1];
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        // Check if click is within the ⊥ button bounds
        if (x >= midX - 12 && x <= midX + 12 && y >= midY - 12 && y <= midY + 12) {
          // Compute perpendicular direction
          const dx = p1.x - p0.x;
          const dy = p1.y - p0.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const perpX = -dy / len;
          const perpY = dx / len;
          const stubLen = 40;
          // Create perpendicular measurement
          onMeasurementAdd({
            id: Date.now().toString(),
            type: 'perpendicular',
            points: [
              { x: midX, y: midY },
              { x: midX + perpX * stubLen, y: midY + perpY * stubLen },
            ],
            slice: currentSlice,
            plane,
            baseLineId: selectedLineId,
          });
          setSelectedLineId(null)
          return;
        }
      }
    }

    if (activeTool === 'distance' || activeTool === 'line') {
      if (!isDrawing) {
        setIsDrawing(true);
        setDrawingPoints([{ x, y }]);
      } else {
        const sc = snapCoord(x, y);
        const points = [...drawingPoints, { x: sc.x, y: sc.y }];
        const value = calculateMeasurementValue('distance', points);
        onMeasurementAdd({
          id: Date.now().toString(),
          type: activeTool,
          points,
          slice: currentSlice,
          plane,
          value,
        });
        setIsDrawing(false);
        setDrawingPoints([]);
      }
    } else if (activeTool === 'angle') {
      if (!isDrawing) {
        setIsDrawing(true);
        setDrawingPoints([{ x, y }]);
      } else if (drawingPoints.length === 1) {
        setDrawingPoints(prev => [...prev, { x, y }]);
      } else if (drawingPoints.length === 2) {
        const sc = snapCoord(x, y);
        const points = [...drawingPoints, { x: sc.x, y: sc.y }];
        const value = calculateMeasurementValue('angle', points);
        onMeasurementAdd({
          id: Date.now().toString(),
          type: 'angle',
          points,
          slice: currentSlice,
          plane,
          value,
        });
        setIsDrawing(false);
        setDrawingPoints([]);
      }
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (isAxial && isZoomMode) {
      applyAxialWheelZoomAtPointer(e.clientX, e.clientY, e.deltaY, e.deltaMode);
      return;
    }
    const delta = e.deltaY > 0 ? 1 : -1;
    const maxSlice = plane === 'axial' ? header.dims[3] : plane === 'sagittal' ? header.dims[1] : header.dims[2];
    const newSlice = Math.max(0, Math.min(maxSlice - 1, currentSlice + delta));
    onSliceChange(newSlice);
  };

  // When entering pan mode, only clamp pan to valid range (do not reset zoom).
  useEffect(() => {
    if (activeTool !== 'pan') return;

    const dims = sliceDimsRef.current;
    const w = Math.max(1, dims.w || 1);
    const h = Math.max(1, dims.h || 1);
    setPanSrc(prev => ({
      x: Math.max(0, Math.min(w - 1, prev.x)),
      y: Math.max(0, Math.min(h - 1, prev.y)),
    }));
  }, [activeTool]);

  // Reset zoom when leaving pan tool unless axial zoom mode is active (preserve zoom).
  useEffect(() => {
    if (activeTool === 'pan') return;
    if (isAxial && isZoomMode) return;
    zoomScaleRef.current = 1;
    panSrcRef.current = { x: 0, y: 0 };
    setZoomScale(1);
    setPanSrc({ x: 0, y: 0 });
  }, [activeTool, isAxial, isZoomMode]);

  const dims = header.dims;
  const maxSlice = plane === 'axial' ? dims[3] : plane === 'sagittal' ? dims[1] : dims[2];

  // Ensure we have sensible display sizes so the wrapper takes space in the layout
  const { width: imgW, height: imgH } = getSliceData();
  const displayW = displaySize.width || imgW;
  const displayH = displaySize.height || imgH;

  return (
    <div className="relative bg-gray-900 rounded-lg border border-gray-800 overflow-hidden flex flex-col h-full w-full">
      {/* debug overlay removed for cleaner UI */}
      <div className="absolute top-2 left-2 z-10 bg-black bg-opacity-50 px-2 py-1 rounded text-xs text-white">
        <div className="font-semibold capitalize">{plane}</div>
        <div className="text-gray-400">
          Slice: {currentSlice + 1}/{maxSlice}
        </div>
        <div className="text-gray-400 mt-1">
          W: {Math.round(windowLevel.window)} L: {Math.round(windowLevel.level)}
        </div>
      </div>
      {isAxial && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 bg-black bg-opacity-50 p-1 rounded text-xs text-white">
          <button
            className={`px-2 py-1 rounded ${isRotateMode ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}
            onClick={() => {
              setIsRotateMode(v => {
                const next = !v;
                if (next) setIsZoomMode(false);
                return next;
              });
              stopRotateDrag();
            }}
          >
            Rotate
          </button>
          <button
            className={`px-2 py-1 rounded ${isZoomMode ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}
            onClick={() => {
              setIsZoomMode(v => {
                const next = !v;
                if (next) {
                  setIsRotateMode(false);
                  stopRotateDrag();
                  lastPointerClientRef.current = null;
                }
                return next;
              });
            }}
          >
            Zoom
          </button>
          <button
            className="px-2 py-1 bg-gray-700 rounded hover:bg-gray-600"
            onClick={() => setAxialTransform({ rotation: 0 })}
          >
            0 deg
          </button>
          <button
            className="px-2 py-1 bg-gray-700 rounded hover:bg-gray-600"
            onClick={() => {
              setAxialTransform({ rotation: 0 });
              zoomScaleRef.current = 1;
              panSrcRef.current = { x: 0, y: 0 };
              setZoomScale(1);
              setPanSrc({ x: 0, y: 0 });
              setIsRotateMode(false);
              setIsZoomMode(false);
              lastPointerClientRef.current = null;
              stopRotateDrag();
            }}
          >
            Reset
          </button>
          {isZoomMode && (
            <span className="text-[10px] text-gray-400 max-w-[140px] leading-tight pl-1">
              Hover and scroll — zooms toward cursor
            </span>
          )}
        </div>
      )}


      {/* Auto WL flash */}
      {autoFlash && (
        <div className="absolute top-16 left-1/2 transform -translate-x-1/2 z-20 bg-green-800 bg-opacity-80 px-3 py-1 rounded text-xs text-white">
          Auto WL applied — W: {autoFlash.window} L: {autoFlash.level}
        </div>
      )}

      <div ref={containerRef} className="flex-1 flex items-center justify-center p-4 overflow-auto min-h-0">
        <div
          className="relative flex items-center justify-center w-full h-full"
          style={{ overflow: 'visible' }}
        >
          <div className="flex items-center" style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            <div className="relative" style={{ width: `${displayW}px`, height: `${displayH}px` }}>
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
                style={{ imageRendering: 'auto' }}
              />
              <canvas
                ref={overlayCanvasRef}
                className="absolute inset-0 w-full h-full"
                style={{
                  cursor: activeSnap
                    ? 'cell'
                    : isAxial && isZoomMode
                    ? 'zoom-in'
                    : isAxial && isRotateMode
                      ? 'ew-resize'
                      : activeTool === 'pan'
                        ? (isPanning ? 'grabbing' : 'grab')
                        : 'crosshair',
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onClick={handleClick}
                onWheel={handleWheel}
              />
            </div>

            {/* Vertical slice slider in the non-image area to the right */}
            <div ref={sliderRef} className="ml-4 flex flex-col items-center" style={{ height: `${displayH}px`, minHeight: '56px' }}>
              <div className="text-xs text-gray-200 mb-2">{currentSlice + 1}</div>
              <div className="h-full flex items-center">
                <Slider
                  orientation="vertical"
                  value={[currentSlice]}
                  onValueChange={(arr) => onSliceChange(arr[0])}
                  min={0}
                  max={Math.max(0, maxSlice - 1)}
                  step={1}
                  className="h-full"
                />
              </div>
              <div className="text-xs text-gray-200 mt-2">{maxSlice}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
