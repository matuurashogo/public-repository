// 買い時ボード（TBK-0006）: data/buy_levels.json を読み、監視リスト銘柄の
// 「あといくら下がったら買いか」（レベル価格6本・到達/接近・陽転）を表示する。
// データの正は jquants-data（GitHub Actions が tools/gen_buy_levels.py で日次生成して同梱）。
// 本モジュールは JSON を表示するだけで、レベルの再計算はしない（契約は TBK-0006）。

let _payload = null;

export async function loadBuyLevels() {
  try {
    const res = await fetch("./data/buy_levels.json", { cache: "no-cache" });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.stocks)) _payload = data;
    }
  } catch (e) {
    // 取得できなくても致命的ではない（ボードカードが出ないだけ）
    console.warn("buy_levels.json の読み込みに失敗:", e);
  }
  return _payload;
}

export function getBuyLevels() {
  return _payload;
}

// レベルの状態: "hit"（到達済み） / "near"（接近 = あと near_threshold 以内） / "far"
export function levelState(level, nearThreshold) {
  if (level.hit) return "hit";
  if (level.dist >= -(nearThreshold || 0.03)) return "near";
  return "far";
}

// 距離の表示文字列。到達済みは「到達」、未到達は「あと◯%」。
export function fmtDist(level) {
  if (level.hit) return "到達";
  return `あと${(-level.dist * 100).toFixed(1)}%`;
}

// 連れ安度バッジ（TBK-0009）。急落イベント銘柄のみ tsureyasu を持つ。
// 連れ安=🟢（買える押し目）/ 個別急落=🔴（深くても見送り）。無ければ null。
export function tsureyasuBadge(tsureyasu) {
  if (!tsureyasu || !tsureyasu.event || !tsureyasu.tag) return null;
  const good = tsureyasu.tag === "連れ安";
  const r5 = typeof tsureyasu.self_r5 === "number" ? `${(tsureyasu.self_r5 * 100).toFixed(1)}%` : "";
  const resid =
    typeof tsureyasu.resid === "number" ? `業種差${(tsureyasu.resid * 100).toFixed(1)}pt` : "";
  return {
    text: good ? "🟢連れ安" : "🔴個別急落",
    cls: good ? "bl-tsure-good" : "bl-tsure-bad",
    title: `5日${r5}・${resid}（${good ? "業種なみの連れ安＝買える押し目" : "業種より大きく下落＝見送り"}）`,
  };
}

// 表示用の行データを組み立てる純粋関数（テスト対象）。
// 並び順: 到達レベル数が多い銘柄 → 最も近いレベルが近い銘柄 の順（行動が必要な順）。
export function buildBoard(payload) {
  if (!payload || !Array.isArray(payload.stocks)) return null;
  const near = payload.near_threshold || 0.03;
  const rows = payload.stocks.map((s) => {
    const cells = (s.levels || []).map((lv) => ({
      id: lv.id,
      label: lv.label,
      price: lv.price,
      state: levelState(lv, near),
      distText: fmtDist(lv),
    }));
    const hitCount = cells.filter((c) => c.state === "hit").length;
    // 未到達レベルのうち最も近い距離（全到達なら 0）
    const dists = (s.levels || []).filter((lv) => !lv.hit).map((lv) => -lv.dist);
    const nearest = dists.length ? Math.min(...dists) : 0;
    return {
      code: s.code,
      close: s.close,
      rebound: !!s.rebound,
      tsureyasu: s.tsureyasu || null,
      hitCount,
      nearest,
      cells,
    };
  });
  rows.sort((a, b) => b.hitCount - a.hitCount || a.nearest - b.nearest);
  return { updated: payload.updated || "", rows };
}

// ボードを #buylevels-table へ描画する。データが無ければカードを隠したまま何もしない。
// intraday（{prices, label} | null・TBK-0008）が渡されたら現在値の「表示だけ」場中価格に
// 差し替える。🟢/🟡（hit/near）の判定は終値ベースのまま変えない。
export function renderBuyLevels(payload, codeToName, intraday = null) {
  const card = document.getElementById("buylevels-card");
  const table = document.getElementById("buylevels-table");
  const dateEl = document.getElementById("buylevels-date");
  if (!card || !table) return;

  const board = buildBoard(payload);
  if (!board || !board.rows.length) {
    card.hidden = true;
    return;
  }

  if (dateEl) {
    const base = board.updated ? `基準日 ${board.updated}` : "";
    dateEl.textContent = intraday ? `${base} ／ 現在値 ${intraday.label}時点` : base;
  }

  // ヘッダー: 全銘柄のレベル ID/ラベルの和集合（通常は L1..L6 で共通）
  const levelDefs = [];
  const seen = new Set();
  for (const r of board.rows) {
    for (const c of r.cells) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        levelDefs.push({ id: c.id, label: c.label });
      }
    }
  }
  levelDefs.sort((a, b) => a.id.localeCompare(b.id));

  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";

  const trh = document.createElement("tr");
  trh.innerHTML =
    `<th class="bl-name">銘柄</th><th>現在値</th>` +
    levelDefs.map((d) => `<th>${d.label}</th>`).join("");
  thead.appendChild(trh);

  for (const r of board.rows) {
    const name = (codeToName && codeToName(r.code)) || "";
    const cellsById = Object.fromEntries(r.cells.map((c) => [c.id, c]));
    const tds = levelDefs
      .map((d) => {
        const c = cellsById[d.id];
        if (!c) return `<td class="muted">—</td>`;
        return (
          `<td class="bl-cell bl-${c.state}">` +
          `<span class="bl-price">${Number(c.price).toLocaleString()}</span>` +
          `<span class="bl-dist">${c.distText}</span></td>`
        );
      })
      .join("");
    // 現在値の表示だけ場中価格に差し替える（hit/near の判定は終値ベースのまま）
    const livePrice = intraday && intraday.prices ? Number(intraday.prices[r.code]) : NaN;
    const closeText = Number.isFinite(livePrice)
      ? livePrice.toLocaleString()
      : Number(r.close).toLocaleString();
    const badge = tsureyasuBadge(r.tsureyasu);
    const badgeHtml = badge
      ? `<span class="bl-tsure ${badge.cls}" title="${badge.title}">${badge.text}</span>`
      : "";
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="bl-name">${r.code}<span class="bl-stock-name">${name}</span>${badgeHtml}</td>` +
      `<td class="bl-close">${closeText}${r.rebound ? '<span class="bl-rebound" title="陽転（下げ止まり）">↗</span>' : ""}</td>` +
      tds;
    tbody.appendChild(tr);
  }

  card.hidden = false;
}
