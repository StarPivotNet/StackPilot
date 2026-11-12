import { useId } from "react";
import type { Tone } from "../../types/app";

function Sparkline({ values, tone = "blue" }: { values: number[]; tone?: string }) {
  const gradientId = `spark-${useId().replace(/:/g, "")}`;
  if (!values.length) return <span className="resource-unavailable">暂无采集数据</span>;
  const safeValues = values.length > 0 ? values : [0];
  const max = Math.max(...safeValues);
  const min = Math.min(...safeValues);
  const range = Math.max(max - min, 1);
  const chart = { left: 6, right: 114, top: 8, bottom: 48 };
  const width = chart.right - chart.left;
  const denominator = Math.max(safeValues.length - 1, 1);
  const average = safeValues.reduce((sum, value) => sum + value, 0) / safeValues.length;
  const xFor = (index: number) => chart.left + (index / denominator) * width;
  const yFor = (value: number) => chart.bottom - ((value - min) / range) * (chart.bottom - chart.top);
  const points = safeValues.map((value, index) => ({ x: xFor(index), y: yFor(value), value }));
  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${chart.bottom} L ${points[0].x.toFixed(2)} ${chart.bottom} Z`;
  const averageY = yFor(average);
  const peakIndex = safeValues.findIndex((value) => value === max);
  const peakPoint = points[peakIndex] ?? points[points.length - 1];
  const currentPoint = points[points.length - 1];
  const barWidth = Math.max(2.4, Math.min(5.6, (width / safeValues.length) * 0.42));

  return (
    <svg className={`spark ${tone}`} viewBox="0 0 120 56" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <g className="spark-grid">
        {[12, 28, 44].map((y) => (
          <line key={`h-${y}`} x1={chart.left} x2={chart.right} y1={y} y2={y} vectorEffect="non-scaling-stroke" />
        ))}
        {[chart.left, chart.left + width / 2, chart.right].map((x) => (
          <line key={`v-${x}`} x1={x} x2={x} y1={chart.top} y2={chart.bottom} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      <g className="spark-bars">
        {points.map((point, index) => {
          const height = Math.max(chart.bottom - point.y, 2);
          return <rect key={`${index}-${point.value}`} x={point.x - barWidth / 2} y={chart.bottom - height} width={barWidth} height={height} rx="1.5" />;
        })}
      </g>
      <path className="spark-area" d={areaPath} fill={`url(#${gradientId})`} />
      <line className="spark-baseline" x1={chart.left} x2={chart.right} y1={averageY} y2={averageY} vectorEffect="non-scaling-stroke" />
      <line className="spark-current-guide" x1={currentPoint.x} x2={currentPoint.x} y1={chart.top} y2={chart.bottom} vectorEffect="non-scaling-stroke" />
      <path className="spark-line" d={linePath} vectorEffect="non-scaling-stroke" />
      {peakIndex !== points.length - 1 && <circle className="spark-point peak" cx={peakPoint.x} cy={peakPoint.y} r="2.7" vectorEffect="non-scaling-stroke" />}
      <circle className="spark-point current" cx={currentPoint.x} cy={currentPoint.y} r="3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Bar({ value, tone }: { value: string; tone: Tone }) {
  if (!Number.isFinite(Number.parseFloat(value))) return <span className="resource-unavailable">{value || "暂无采集数据"}</span>;
  return (
    <span className="bar-cell">
      <em>{value}</em>
      <i><b className={tone} style={{ width: value }} /></i>
    </span>
  );
}

function StatusLight({ tone }: { tone: Tone | string }) {
  return <i className={`status-light ${tone}`} />;
}

function StatusDot({ text, tone = "green" }: { text: string; tone?: Tone | string }) {
  return <span className="status-dot"><StatusLight tone={tone} />{text}</span>;
}

export { Sparkline, Bar, StatusLight, StatusDot };
