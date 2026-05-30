// 累積損益の折れ線グラフ（Chart.js 同梱版を利用）
// Chart は js/vendor/chart.umd.min.js が <script> で読み込み、グローバルに公開される。

import { cumulative } from "./pnl.js";

let _chart = null;

const GAIN = "#128a3a";
const LOSS = "#d42f2f";

// records: calcRealized().records を受け取り、累積系列を描画する
export function renderCumulative(canvas, records) {
  if (typeof window === "undefined" || !window.Chart) return;
  const series = cumulative(records);

  const labels = series.map((p) => p.date.slice(5)); // MM-DD
  const data = series.map((p) => p.cum);
  const last = data.length ? data[data.length - 1] : 0;
  const color = last >= 0 ? GAIN : LOSS;

  if (_chart) {
    _chart.destroy();
    _chart = null;
  }

  // データが無いときは空表示
  if (series.length === 0) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  _chart = new window.Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor: color,
          backgroundColor: color + "1A", // 透過塗り
          fill: true,
          tension: 0.25,
          pointRadius: 3,
          pointBackgroundColor: color,
          borderWidth: 2.5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => "累積 " + formatYen(c.parsed.y),
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
        y: {
          grid: { color: "#f0f0f2" },
          ticks: { callback: (v) => formatYen(v) },
        },
      },
    },
  });
}

function formatYen(n) {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return sign + Math.abs(n).toLocaleString("ja-JP") + "円";
}
