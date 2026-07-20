// 累積損益の折れ線グラフ（Chart.js 同梱版を利用）
// Chart は js/vendor/chart.umd.min.js が <script> で読み込み、グローバルに公開される。

import { cumulative, histogramBins } from "./pnl.js";

let _chart = null;

// 損益色はCSS変数を単一の真実とし、チャートもそこから読む（表・リストと完全一致させる）。
function lossGainColors() {
  const fallback = { GAIN: "#128a3a", LOSS: "#d42f2f" };
  if (typeof window === "undefined" || !document.documentElement) return fallback;
  const s = getComputedStyle(document.documentElement);
  return {
    GAIN: s.getPropertyValue("--gain").trim() || fallback.GAIN,
    LOSS: s.getPropertyValue("--loss").trim() || fallback.LOSS,
  };
}
function reduceMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// records: calcRealized().records を受け取り、累積系列を描画する
export function renderCumulative(canvas, records) {
  if (typeof window === "undefined" || !window.Chart) return;
  const { GAIN, LOSS } = lossGainColors();
  const series = cumulative(records);

  const labels = series.map((p) => p.date.slice(5)); // MM-DD
  const data = series.map((p) => p.cum);
  const last = data.length ? data[data.length - 1] : 0;
  const color = last >= 0 ? GAIN : LOSS;

  // 登場アニメ: 線を左から1点ずつ描き進める（Chart.js公式のprogressive line方式）。
  // reduce-motion時はアニメ無効で即時表示。
  const totalDuration = 800;
  const dl = totalDuration / Math.max(data.length, 1);
  const lineAnimation = reduceMotion()
    ? false
    : {
        x: {
          type: "number",
          easing: "linear",
          duration: dl,
          from: NaN,
          delay(ctx) {
            if (ctx.type !== "data" || ctx.xStarted) return 0;
            ctx.xStarted = true;
            return ctx.index * dl;
          },
        },
        y: {
          type: "number",
          easing: "linear",
          duration: dl,
          from(ctx) {
            if (ctx.index === 0) return ctx.chart.scales.y.getPixelForValue(data[0]);
            const prev = ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.index - 1];
            return prev ? prev.getProps(["y"], true).y : ctx.chart.scales.y.getPixelForValue(0);
          },
          delay(ctx) {
            if (ctx.type !== "data" || ctx.yStarted) return 0;
            ctx.yStarted = true;
            return ctx.index * dl;
          },
        },
      };

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
      animation: lineAnimation,
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

let _stock = null;

// 銘柄詳細モーダルの価格チャート（TBK 詳細モーダル）。終値の折れ線＋支持/抵抗の横線のみ。
// model: detail.buildChartModel() の戻り値 { labels[], close[], srLines[{value,kind}], hasData }。
// 横線は追加プラグインを使わず「全x点に定数yを持つ線データセット」で描く（Chart.js 標準機能のみ）。
export function renderStockChart(canvas, model) {
  if (typeof window === "undefined" || !window.Chart || !canvas) return;
  if (_stock) {
    _stock.destroy();
    _stock = null;
  }
  const ctx = canvas.getContext("2d");
  if (!model || !model.hasData) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const { GAIN, LOSS } = lossGainColors();
  const n = model.labels.length;

  const priceDataset = {
    label: "終値",
    data: model.close,
    borderColor: "#2b6cb0",
    backgroundColor: "rgba(43,108,176,0.08)",
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.15,
    fill: true,
    order: 2,
  };

  // 支持=緑 / 抵抗=赤 の水平線。凡例ラベルに価格を載せる（横線が何の水準か分かるように）。
  const srDatasets = (model.srLines || []).map((l) => ({
    label: `${l.kind === "support" ? "支持" : "抵抗"} ${Math.round(l.value).toLocaleString("ja-JP")}`,
    data: new Array(n).fill(l.value),
    borderColor: l.kind === "support" ? GAIN : LOSS,
    borderWidth: 1,
    borderDash: [5, 4],
    pointRadius: 0,
    fill: false,
    order: 1,
  }));

  _stock = new window.Chart(ctx, {
    type: "line",
    data: { labels: model.labels, datasets: [priceDataset, ...srDatasets] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: reduceMotion() ? false : { duration: 500 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: srDatasets.length > 0,
          position: "bottom",
          labels: { boxWidth: 18, font: { size: 10 }, filter: (item) => item.text !== "終値" },
        },
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${Math.round(c.parsed.y).toLocaleString("ja-JP")}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6, font: { size: 9 } } },
        y: {
          grid: { color: "#f0f0f2" },
          ticks: { callback: (v) => Math.round(v).toLocaleString("ja-JP"), font: { size: 10 } },
        },
      },
    },
  });
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

  const { GAIN, LOSS } = lossGainColors();
  const counts = bins.map((b) => b.count);
  const labels = bins.map((b) => shortYen(b.lo) + "〜" + shortYen(b.hi));
  const colors = bins.map((b) => (b.sign === "loss" ? LOSS : GAIN));

  // 登場アニメ: 棒を左から順ににょきっと伸ばす。reduce-motion時は無効。
  const barAnimation = reduceMotion()
    ? false
    : {
        duration: 650,
        easing: "easeOutQuart",
        delay: (ctx) => (ctx.type === "data" && ctx.mode === "default" ? ctx.dataIndex * 70 : 0),
      };

  _hist = new window.Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{ data: counts, backgroundColor: colors, borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: barAnimation,
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
