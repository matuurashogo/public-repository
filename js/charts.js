// 累積損益の折れ線グラフ（Chart.js 同梱版を利用）
// Chart は js/vendor/chart.umd.min.js が <script> で読み込み、グローバルに公開される。

import { cumulative, histogramBins } from "./pnl.js";

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

// 千円/万円の見やすい短縮表記（ヒストグラムの軸ラベル用）
function shortYen(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 10000) return sign + (a / 10000).toFixed(a >= 100000 ? 0 : 1) + "万";
  return sign + Math.round(a).toLocaleString("ja-JP");
}

let _hist = null;

// 売却ごとの実現損益(pnls)を金額帯でビン分けしたヒストグラムを描く。
// 損=赤 / 益=緑。「コツコツ勝ってドカン負け」の形が一目で分かる。
export function renderHistogram(canvas, pnls) {
  if (typeof window === "undefined" || !window.Chart) return;

  if (_hist) {
    _hist.destroy();
    _hist = null;
  }
  const ctx = canvas.getContext("2d");
  // ビン分けは純粋関数 histogramBins() に委譲（テスト対象）。空入力は []
  const bins = histogramBins(pnls, 7);
  if (bins.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const counts = bins.map((b) => b.count);
  const labels = bins.map((b) => shortYen(b.lo) + "〜" + shortYen(b.hi));
  const colors = bins.map((b) => (b.sign === "loss" ? LOSS : GAIN));

  _hist = new window.Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{ data: counts, backgroundColor: colors, borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (c) => c.parsed.y + " 件" },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, font: { size: 9 } } },
        y: { grid: { color: "#f0f0f2" }, ticks: { precision: 0 }, beginAtZero: true },
      },
    },
  });
}
