export interface SnapPoint {
  x: number;
  y: number;
  type: 'endpoint' | 'midpoint';
  annotationId: string;
}

const SNAP_RADIUS = 12;

export function getSnapPoints(measurements: any[]): SnapPoint[] {
  const points: SnapPoint[] = [];
  for (const m of measurements) {
    if (m.points.length < 2) continue;
    const [p1, p2] = m.points;
    points.push({ x: p1.x, y: p1.y, type: 'endpoint', annotationId: m.id });
    points.push({ x: p2.x, y: p2.y, type: 'endpoint', annotationId: m.id });
    points.push({
      x: (p1.x + p2.x) / 2,
      y: (p1.y + p2.y) / 2,
      type: 'midpoint',
      annotationId: m.id,
    });
  }
  return points;
}

export function findNearestSnap(
  mouseX: number,
  mouseY: number,
  snapPoints: SnapPoint[]
): SnapPoint | null {
  let nearest: SnapPoint | null = null;
  let minDist = SNAP_RADIUS;
  for (const pt of snapPoints) {
    const dist = Math.hypot(pt.x - mouseX, pt.y - mouseY);
    if (dist < minDist) {
      minDist = dist;
      nearest = pt;
    }
  }
  return nearest;
}

export function drawSnapIndicator(
  ctx: CanvasRenderingContext2D,
  snap: SnapPoint
) {
  ctx.save();
  if (snap.type === 'midpoint') {
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const s = 7;
    ctx.moveTo(snap.x, snap.y - s);
    ctx.lineTo(snap.x + s, snap.y);
    ctx.lineTo(snap.x, snap.y + s);
    ctx.lineTo(snap.x - s, snap.y);
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 1.5;
    const s = 6;
    ctx.strokeRect(snap.x - s, snap.y - s, s * 2, s * 2);
  }
  ctx.restore();
}