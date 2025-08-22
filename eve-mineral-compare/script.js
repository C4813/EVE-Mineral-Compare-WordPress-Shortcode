
/* global jQuery, eveMineralCompare */
jQuery(function ($) {
  'use strict';

  var ASSUMED_UNITS = 100000;      // pseudo cap for single-price legs
  var OFFHUB_SIM_QTY = 100000;     // simulate 100k units for off-hub fee math
  var emcRefreshXhr = null;        // tracks the current REST request
  var COOLDOWN_SEC  = 20;          // forced 20s cooldown animation
  var LS_NEXT_REFRESH_AT = 'emcNextRefreshAt';
  var LS_BUY_FROM  = 'emcBuyFrom';
  var LS_SELL_TO   = 'emcSellTo';
  var LS_STANDINGS = 'emcStandings';
  // NEW: shared keys for extended table persistence
  var LS_EXT_HUBS  = 'emcExtHubs';     // JSON array of hub ids/values
  var LS_EXT_LIMIT = 'emcExtLimit60k'; // '1' or '0'

  // Polling timer handle so we can cancel on unload
  var emcPollTimer = null;

  // ---- ESI downtime window (UTC) ----
  function emcIsDowntimeUtc() {
    var now = new Date();
    var hh = now.getUTCHours();
    var mm = now.getUTCMinutes();
    return ( (hh === 10 && mm >= 55) || (hh === 11 && mm < 30) );
  }
  function emcShowDowntimeMessage() {
    var $status = $('#eve-mineral-status');
    if (!$status.length) return;
    $status.empty()
      .append($('<span/>', { 'class': 'emc-status-line', text: 'Disabled between 10:55 and 11:30 UTC' }))
      .append($('<span/>', { 'class': 'emc-status-line', text: '( downtime +/- )' }))
      .append($('<span/>', { 'class': 'emc-status-sub',  text: 'ESI is unreliable during this time' }));
  }

  // ---------- utils ----------
  function formatNumber(val) {
    if (val === null || val === undefined || val === 'N/A') return 'N/A';
    var n = Number(val);
    if (!Number.isFinite(n)) return 'N/A';
    if (n % 1 !== 0) {
      return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return n.toLocaleString();
  }

  function debounce(fn, delay) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function(){ fn.apply(ctx, args); }, delay);
    };
  }

  // Cache-buster for GET requests (defense vs stale caches/proxies)
  function addCacheBuster(url) {
    if (!url || typeof url !== 'string') return url;
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    return url + sep + '_ts=' + Date.now();
  }

  function prettyAge(sec) {
    if (!Number.isFinite(sec) || sec < 0) return 'unknown';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + ' hour' + (h === 1 ? '' : 's') + ' ' + m + ' minute' + (m === 1 ? '' : 's');
    return m + ' minute' + (m === 1 ? '' : 's');
  }

  // Data is "ready" only if at least one hub has a finite buy or sell
  function isDataReady(data) {
    if (!data || typeof data !== 'object') return false;
    for (var tid in data) {
      if (!Object.prototype.hasOwnProperty.call(data, tid)) continue;
      var m = data[tid];
      if (!m || !m.hubs) continue;
      for (var hub in m.hubs) {
        if (!Object.prototype.hasOwnProperty.call(m.hubs, hub)) continue;
        var h = m.hubs[hub];
        if (!h) continue;
        if (Number.isFinite(h.buy) || Number.isFinite(h.sell)) return true;
      }
    }
    return false;
  }

  // =========================================================
  // Strict decimal-only inputs (with proper behavior per field)
  // =========================================================
  var POSITIVE_DECIMALS = '#emc-adv-brokerage, #emc-adv-tax, .emc-adv-input, #emc-min-margin';
  var STANDINGS_INPUTS  = '.emc-standing-input';

  // --- helpers
  function normalizePositive(str) {
    if (typeof str !== 'string') str = String(str || '');
    str = str.replace(',', '.');                 // allow comma typing
    str = str.replace(/[^0-9.]/g, '');           // keep digits + dot only
    // collapse extra dots
    var parts = str.split('.');
    if (parts.length > 2) str = parts[0] + '.' + parts.slice(1).join('');
    // keep max 2 decimals
    parts = str.split('.');
    if (parts[1]) str = parts[0] + '.' + parts[1].slice(0, 2);
    return str;
  }

  function normalizeSigned(str) {
    if (typeof str !== 'string') str = String(str || '');
    str = str.replace(',', '.');
    // keep digits, dot, one leading -
    str = str.replace(/[^0-9.\-]/g, '');
    // ensure single leading minus
    str = str.replace(/(?!^)-/g, '');
    if (str.indexOf('-') > 0) str = '-' + str.replace(/-/g, '');
    // collapse extra dots
    var parts = str.split('.');
    if (parts.length > 2) str = parts[0] + '.' + parts.slice(1).join('');
    // limit decimals
    parts = str.split('.');
    if (parts[1]) str = parts[0] + '.' + parts[1].slice(0, 2);
    return str;
  }

  function allowKeysPositive(e) {
    var k = e.key;
    var c = e.code || '';
    if (
      k === 'Backspace' || k === 'Delete' || k === 'Tab' ||
      k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End' ||
      (/^\d$/.test(k)) || k === '.' || k === ',' || k === 'Decimal' || c === 'NumpadDecimal'
    ) return;
    e.preventDefault();
  }

  function allowKeysSigned(e) {
    var k = e.key;
    var c = e.code || '';
    if (
      k === 'Backspace' || k === 'Delete' || k === 'Tab' ||
      k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End' ||
      (/^\d$/.test(k)) || k === '.' || k === ',' || k === 'Decimal' || c === 'NumpadDecimal' || k === '-'
    ) return;
    e.preventDefault();
  }

  // positive-decimal fields (off-hub + min margin)
  $(document).on('keydown', POSITIVE_DECIMALS, allowKeysPositive);
  $(document).on('input',  POSITIVE_DECIMALS, function () {
    var after = normalizePositive($(this).val());
    if ($(this).val() !== after) $(this).val(after);
  });
  // improve soft keyboard hints without changing markup
  $(POSITIVE_DECIMALS).attr({
    inputmode: 'decimal',
    pattern: '[0-9]*[\\.,]?[0-9]{0,2}',
    step: 'any',
    type: 'text' // ensure dot/comma allowed across browsers
  });
  // Auto-select value on focus/click for fast replacement
  $(document).on('focus click', POSITIVE_DECIMALS, function () {
    var el = this;
    setTimeout(function(){ try { el.select(); } catch(e){} }, 0);
  });

  // signed-decimal fields (base standings)
  $(document).on('keydown', STANDINGS_INPUTS, allowKeysSigned);
  $(document).on('input', STANDINGS_INPUTS, function () {
    var val = $(this).val();
    if (val === '') { updateEffectiveStandings(); updateFeesDisplay(); return; }
    var after = normalizeSigned(val);
    if (val !== after) $(this).val(after);
    updateEffectiveStandings();
    updateFeesDisplay();
  });
  // clamp to [-10,10] only when leaving the field
  $(document).on('blur', STANDINGS_INPUTS, function () {
    var raw = String($(this).val() || '').replace(',', '.').trim();
    if (raw === '') {
      // leave visually empty; treat as 0 in calculations
      $(this).val('');
      saveStandingsToLocalStorage();
      updateEffectiveStandings();
      updateFeesDisplay();
      return;
    }
    var num = parseFloat(raw);
    if (!Number.isFinite(num)) { num = 0; }
    num = Math.max(-10, Math.min(10, num));
    $(this).val(num.toFixed(2));
    saveStandingsToLocalStorage();
    updateEffectiveStandings();
    updateFeesDisplay();
  });
  // make them show placeholder 0.00 and start empty
  $(STANDINGS_INPUTS).attr({
    inputmode: 'decimal',
    pattern: '-?[0-9]*[\\.,]?[0-9]{0,2}',
    step: 'any',
    type: 'text',
    placeholder: '0.00'
  });
  $(STANDINGS_INPUTS).each(function(){
    var v = String($(this).val() || '').trim();
    if (v === '0' || v === '0.0' || v === '0.00') { $(this).val(''); }
  });

  // initial compute so fees reflect default 0.00 values
  updateEffectiveStandings();
  updateFeesDisplay();

  // ---------- standings & fee math ----------
  function calcEffectiveStanding(baseStanding, connectionsSkill, diplomacySkill) {
    baseStanding = Number(baseStanding) || 0;
    if (baseStanding === 0) return 0;
    connectionsSkill = Number(connectionsSkill) || 0;
    diplomacySkill   = Number(diplomacySkill) || 0;

    var eff = baseStanding > 0
      ? baseStanding + (10 - baseStanding) * 0.04 * connectionsSkill
      : baseStanding + (10 - baseStanding) * 0.04 * diplomacySkill;

    eff = Math.min(10, Math.max(-10, eff));
    return Math.round(eff * 100) / 100;
  }

  function calcSalesTax(accountingLevel) {
    return 0.075 * (1 - (0.11 * (Number(accountingLevel) || 0)));
  }

  function calcBrokerFee(brokerRelationsLevel, factionStanding, corpStanding) {
    var fee = 0.03 - 0.003 * (Number(brokerRelationsLevel) || 0)
                    - 0.0003 * (Number(factionStanding)  || 0)
                    - 0.0002 * (Number(corpStanding)     || 0);
    return fee < 0 ? 0 : fee;
  }

  // ---------- fees table readers ----------
  function getBrokerageAndTaxForHub() {
    var fees = {};
    $('#emc-fees-summary tbody tr').each(function () {
      var $c = $(this).find('td');
      var hub = $c.eq(0).text().trim();
      var fee = parseFloat($c.eq(1).text().replace('%', ''));
      if (!Number.isNaN(fee)) fees[hub] = fee / 100;
    });
    return fees;
  }
  function getSalesTaxForHub() {
    var taxes = {};
    $('#emc-fees-summary tbody tr').each(function () {
      var $c = $(this).find('td');
      var hub = $c.eq(0).text().trim();
      var tax = parseFloat($c.eq(2).text().replace('%', ''));
      if (!Number.isNaN(tax)) taxes[hub] = tax / 100;
    });
    return taxes;
  }

  // ---------- hub filters ----------
  function getAllowedHubsExtended() {
    var hubs = $('#emc-hub-filters-best .emc-hub-toggle:checked')
      .map(function(){ return $(this).val(); }).get();
    if (!hubs.length) {
      hubs = $('#emc-hub-filters-best .emc-hub-toggle')
        .map(function(){ return $(this).val(); }).get();
    }
    return hubs;
  }

  // ---------- pick hub helpers ----------
  // mineral: { hubs: { Jita:{buy,sell,buy_orders,sell_orders}, ... } }
  function pickHub(mineral, field, objective, allowed) {
    if (!mineral || !mineral.hubs) return null;
    var allow = allowed && allowed.length ? (function(list){
      var m = {}; for (var i=0;i<list.length;i++) m[list[i]] = 1; return m;
    })(allowed) : null;

    var bestHub = null;
    var bestPrice = null;

    jQuery.each(mineral.hubs, function (hubName, hv) {
      if (allow && !allow[hubName]) return;
      var price = hv && hv[field];
      if (price == null || price === 'N/A') return;

      if (bestPrice === null) { bestHub = hubName; bestPrice = price; return; }
      if (objective === 'min') {
        if (price < bestPrice) { bestHub = hubName; bestPrice = price; }
      } else {
        if (price > bestPrice) { bestHub = hubName; bestPrice = price; }
      }
    });

    return bestHub ? { hub: bestHub, price: bestPrice } : null;
  }

  // ---------- trade simulation ----------
  // BUY from buy:  brokerage ADDED; use min(highest buys across hubs)  → synthetic
  // BUY from sell: no fee;           use min(lowest sells across hubs)  → ladder
  // SELL to buy:   tax only;         use max(highest buys across hubs)  → ladder
  // SELL to sell:  tax + broker;     use max(highest sells across hubs) → synthetic
  function simulateDepthAcrossOrders(mineral, buyType, sellType, qtyLimit, allowedHubs, brokerageFees, salesTaxRates, minMarginPct) {
    if (!mineral || !mineral.hubs) return null;

    var MAX_SAFE_TOTAL = 1e15; // cap for running totals (cost/revenue)
    var MAX_QTY_CAP    = 1e5;  // guardrail ONLY for non-ladder scenarios (100k)

    // BUYING hub/price pick
    var buyBest = (buyType === 'buy')
      ? pickHub(mineral, 'buy',  'min', allowedHubs)
      : pickHub(mineral, 'sell', 'min', allowedHubs);

    // SELLING hub/price pick
    var sellBest = (sellType === 'buy')
      ? pickHub(mineral, 'buy',  'max', allowedHubs)
      : pickHub(mineral, 'sell', 'max', allowedHubs);

    if (!buyBest || !sellBest) return null;

    var buyHub  = buyBest.hub;
    var sellHub = sellBest.hub;

    var buyUsesLadder  = (buyType  === 'sell');
    var sellUsesLadder = (sellType === 'buy');
    var anyLadder = buyUsesLadder || sellUsesLadder;

    // Raw ladders (only when laddering on that side)
    var rawBuyOrders  = buyUsesLadder  ? (mineral.hubs[buyHub]  && mineral.hubs[buyHub].sell_orders || []) : [];
    var rawSellOrders = sellUsesLadder ? (mineral.hubs[sellHub] && mineral.hubs[sellHub].buy_orders  || []) : [];

    var buyOrders = rawBuyOrders
      .map(function(o){ return ({ price: Number(o.price), vol: Number(o.vol) }); })
      .filter(function(o){ return Number.isFinite(o.price) && o.price > 0 && Number.isFinite(o.vol) && o.vol > 0; });

    var sellOrders = rawSellOrders
      .map(function(o){ return ({ price: Number(o.price), vol: Number(o.vol) }); })
      .filter(function(o){ return Number.isFinite(o.price) && o.price > 0 && Number.isFinite(o.vol) && o.vol > 0; });

    if (buyUsesLadder)  buyOrders.sort(function(a,b){ return a.price - b.price; }); // cheapest sells first
    if (sellUsesLadder) sellOrders.sort(function(a,b){ return b.price - a.price; }); // highest buys first

    function sumVol(arr){ return arr.reduce(function(s,o){ return s + (Number.isFinite(o.vol)?o.vol:0); }, 0); }
    var ladderAvailBuy  = buyUsesLadder  ? sumVol(buyOrders)  : Infinity;
    var ladderAvailSell = sellUsesLadder ? sumVol(sellOrders) : Infinity;

    // User-set quantity limit (distinct from min margin)
    var userQtyLimit = (qtyLimit != null && Number.isFinite(Number(qtyLimit)) && Number(qtyLimit) > 0) ? Number(qtyLimit) : null;

    // Quantity ceiling
    var qtyCeiling;
    if (userQtyLimit != null) {
      if (anyLadder) {
        var ladderBoundForLimit = Math.min(
          buyUsesLadder ? ladderAvailBuy : Infinity,
          sellUsesLadder ? ladderAvailSell : Infinity
        );
        if (!Number.isFinite(ladderBoundForLimit) || ladderBoundForLimit <= 0) return null;
        qtyCeiling = Math.min(userQtyLimit, ladderBoundForLimit);
      } else {
        qtyCeiling = Math.min(userQtyLimit, MAX_QTY_CAP);
      }
    } else if (anyLadder) {
      var ladderBound = Math.min(
        buyUsesLadder ? ladderAvailBuy : Infinity,
        sellUsesLadder ? ladderAvailSell : Infinity
      );
      if (!Number.isFinite(ladderBound) || ladderBound <= 0) return null;
      qtyCeiling = ladderBound;
    } else {
      qtyCeiling = Math.min(ASSUMED_UNITS, MAX_QTY_CAP);
    }

    // For non-ladder legs, synthesize a single pseudo order with qty = qtyCeiling
    if (!buyUsesLadder) {
      var p = Number(buyBest.price);
      if (!Number.isFinite(p) || p <= 0) return null;
      buyOrders = [{ price: p, vol: qtyCeiling }];
    }
    if (!sellUsesLadder) {
      var sp = Number(sellBest.price);
      if (!Number.isFinite(sp) || sp <= 0) return null;
      sellOrders = [{ price: sp, vol: qtyCeiling }];
    }

    // Final max units
    var maxUnits = qtyCeiling;
    if (!Number.isFinite(maxUnits) || maxUnits <= 0) maxUnits = ASSUMED_UNITS;
    if (!anyLadder && maxUnits > MAX_QTY_CAP) maxUnits = MAX_QTY_CAP;

    var buyFee   = Number(brokerageFees[buyHub]  || 0);
    var sellFee  = Number(brokerageFees[sellHub] || 0);
    var tax      = Number(salesTaxRates[sellHub] || 0);
    var minMargin = Number(minMarginPct || 0);

    var filled = 0, totalCost = 0, totalRevenue = 0;
    var bi = 0, si = 0;

    while (filled < maxUnits && bi < buyOrders.length && si < sellOrders.length) {
      var stepQty = Math.min(buyOrders[bi].vol, sellOrders[si].vol, maxUnits - filled);
      if (!Number.isFinite(stepQty) || stepQty <= 0) break;

      var buyPrice  = buyOrders[bi].price;
      var sellPrice = sellOrders[si].price;

      var stepCost = buyPrice * stepQty;
      var stepRev  = sellPrice * stepQty;

      if (!Number.isFinite(stepCost) || !Number.isFinite(stepRev)) break;

      // Fees
      if (buyType  === 'buy')  stepCost += stepCost * buyFee;  // creating a buy order -> brokerage
      if (sellType === 'sell') stepRev  -= stepRev  * sellFee; // creating a sell order -> brokerage
      stepRev -= stepRev * tax; // selling always pays tax

      var newCost = totalCost + stepCost;
      var newRev  = totalRevenue + stepRev;

      if (!Number.isFinite(newCost) || !Number.isFinite(newRev)) break;
      if (newCost > 1e15 || newRev > 1e15) break;

      var stepMargin = newCost > 0 ? ((newRev - newCost) / newCost) * 100 : 0;
      if (stepMargin < minMargin) break;

      totalCost = newCost;
      totalRevenue = newRev;
      filled += stepQty;

      buyOrders[bi].vol  -= stepQty; if (buyOrders[bi].vol  <= 0) bi++;
      sellOrders[si].vol -= stepQty; if (sellOrders[si].vol <= 0) si++;
    }

    var profit = totalRevenue - totalCost;
    var margin = totalCost > 0 ? (profit / totalCost) * 100 : 0;

    if (!Number.isFinite(profit) || !Number.isFinite(margin)) return null;
    if (filled <= 0) return null;
    return { buyHub: buyHub, sellHub: sellHub, filledQty: filled, profit: profit, margin: margin, investment: totalCost };
  }

  // ---------- off-hub calculator: helpers ----------
  function emcParsePosNumber(v) {
    var n = (typeof v === 'string') ? v.replace(',', '.').trim() : v;
    n = Number(n);
    return (Number.isFinite(n) && n >= 0) ? n : NaN;
  }

  function emcSanitizeNumberInput(el) {
    var v = el.value || '';
    v = v.replace(/,/g, '.');          // normalize comma to dot
    v = v.replace(/[^0-9.]/g, '');     // digits + dot only
    v = v.replace(/(\..*)\./g, '$1');  // only one dot
    el.value = v;
  }

  function emcComputeOffHubRow($tr, feePct, taxPct, applyBuyFee, applySellFee, applySellTax) {
    var $buy  = $tr.find('.emc-adv-buy');
    var $sell = $tr.find('.emc-adv-sell');

    var buy  = emcParsePosNumber($buy.val());
    var sell = emcParsePosNumber($sell.val());
    if (!Number.isFinite(buy) || !Number.isFinite(sell)) return null;

    // Simulate Q units so fees apply at true percentage scale
    var Q = OFFHUB_SIM_QTY;

    var totalBuy = buy * Q;
    if (applyBuyFee) totalBuy *= (1 + feePct);
    var totalSell = sell * Q;
    if (applySellFee) totalSell *= (1 - feePct);
    if (applySellTax) totalSell *= (1 - taxPct);

    if (!(totalBuy > 0)) return null;

    var margin = ((totalSell - totalBuy) / totalBuy) * 100;
    if (!Number.isFinite(margin)) return null;
    return margin;
  }

  function emcComputeOffHubAll() {
    if (!$('#emc-adv-table').length) return;

    var feePct = emcParsePosNumber($('#emc-adv-brokerage').val()) || 0;
    var taxPct = emcParsePosNumber($('#emc-adv-tax').val()) || 0;
    feePct = feePct / 100;
    taxPct = taxPct / 100;

    var applyBuyFee   = $('#emc-adv-buy-broker').is(':checked');
    var applySellFee  = $('#emc-adv-sell-broker').is(':checked');
    var applySellTax  = $('#emc-adv-sell-tax').is(':checked');

    $('#emc-adv-table tbody tr').each(function () {
      var $tr = $(this);
      var m = emcComputeOffHubRow($tr, feePct, taxPct, applyBuyFee, applySellFee, applySellTax);
      var $cell = $tr.find('.emc-adv-margin');
      if (m == null) {
        $cell.removeClass('is-pos is-neg').text('N/A');
      } else {
        $cell.text(m.toFixed(2) + '%')
             .toggleClass('is-pos', m >= 0)
             .toggleClass('is-neg', m < 0);
      }
    });
  }

  function initOffHubCalculator() {
    if (!$('#emc-adv-table').length) return;

    // Sanitize numeric on input (fees and per-row fields) and recompute
    $(document).on('input', '#emc-adv-brokerage, #emc-adv-tax, .emc-adv-input', function () {
      emcSanitizeNumberInput(this);
      emcComputeOffHubAll();
    });

    // Recompute on toggles
    $(document).on('change', '#emc-adv-buy-broker, #emc-adv-sell-broker, #emc-adv-sell-tax', function () {
      emcComputeOffHubAll();
    });

    // Clear button
    $(document).on('click', '#emc-adv-clear', function () {
      $('#emc-adv-brokerage, #emc-adv-tax').val('');
      $('#emc-adv-table .emc-adv-buy, #emc-adv-table .emc-adv-sell').val('');
      $('#emc-adv-table .emc-adv-margin').removeClass('is-pos is-neg').text('N/A');
    });

    // Initial render
    emcComputeOffHubAll();
  }

  // ---------- effective standings UI ----------
  function updateEffectiveStandings() {
    var connections = +$('.emc-skill-select[data-skill="connections"]').val() || 0;
    var diplomacy   = +$('.emc-skill-select[data-skill="diplomacy"]').val() || 0;

    $('.emc-standing-input').each(function () {
      // Read raw text, allow "." or "," then parse
      var raw = String($(this).val() || '').replace(',', '.').trim();
      var num = parseFloat(raw);
      // For live calc: if NaN, treat as 0; clamp to [-10, 10] for the math ONLY
      if (!Number.isFinite(num)) num = 0;
      var baseForCalc = Math.max(-10, Math.min(10, num));

      $(this).closest('tr')
        .find('.emc-effective-standing')
        .text(calcEffectiveStanding(baseForCalc, connections, diplomacy).toFixed(2));
    });
  }

  function saveStandingsToLocalStorage() {
    try {
      var data = {};
      $(STANDINGS_INPUTS).each(function(){
        var id = this.id || $(this).data('standing');
        var raw = String($(this).val() || '').trim();
        if (raw === '') return; // don't store empties; base defaults to 0
        data[id] = raw;
      });
      // FIX: use key constant consistently
      localStorage.setItem(LS_STANDINGS, JSON.stringify(data));
    } catch (e) {}
  }

  // ---------- fee table build ----------
  function updateFeesDisplay() {
    var acct  = +$('.emc-skill-select[data-skill="accounting"]').val() || 0;
    var br    = +$('.emc-skill-select[data-skill="broker_relations"]').val() || 0;
    var conn  = +$('.emc-skill-select[data-skill="connections"]').val() || 0;
    var diplo = +$('.emc-skill-select[data-skill="diplomacy"]').val() || 0;

    var tax = calcSalesTax(acct);
    var $tb = $('#emc-fees-summary tbody').empty();

    // hub → faction/corp mapping (inlined; must match PHP)
    var marketMappings = {
      'Jita':    { faction: 'caldari_state',      corp: 'caldari_navy' },
      'Amarr':   { faction: 'amarr_empire',       corp: 'emperor_family' },
      'Rens':    { faction: 'minmatar_republic',  corp: 'brutor_tribe' },
      'Hek':     { faction: 'minmatar_republic',  corp: 'boundless_creations' },
      'Dodixie': { faction: 'gallente_federation',corp: 'federation_navy' }
    };

    jQuery.each(marketMappings, function (hub, ids) {
      var f = calcEffectiveStanding( +($('.emc-standing-input[data-standing="'+ids.faction+'"]').val()) || 0, conn, diplo);
      var c = calcEffectiveStanding( +($('.emc-standing-input[data-standing="'+ids.corp+'"]').val())    || 0, conn, diplo);
      var fee = calcBrokerFee(br, f, c);
      $tb.append(
        '<tr><td>'+hub+
        '</td><td class="emc-td-center">'+(fee*100).toFixed(2)+'%'+
        '</td><td class="emc-td-center">'+(tax*100).toFixed(2)+'%'+
        '</td></tr>'
      );
    });

    // kick table 3 & 4 after fees exist
    setTimeout(updateExtendedTradeTable, 0);
    setTimeout(updateNoUndockTable, 0);
  }

  // ---------- extended table build ----------
  // Format ONLY the investment subline into short ISK (e.g., 234.226 b)
  function emcFormatShortISK(n) {
    if (!isFinite(n)) return '—';
    var abs = Math.abs(n);
    var sign = n < 0 ? '-' : '';

    function ceilTo(num, div) {
      return Math.ceil((num + Number.EPSILON) * 100 / div) / 100; // 2 decimals, always up
    }

    if (abs >= 1e12) return sign + ceilTo(abs, 1e12).toFixed(2) + 't';
    if (abs >= 1e9)  return sign + ceilTo(abs, 1e9 ).toFixed(2) + 'b';
    if (abs >= 1e6)  return sign + ceilTo(abs, 1e6 ).toFixed(2) + 'm';
    if (abs >= 1e3)  return sign + ceilTo(abs, 1e3 ).toFixed(2) + 'k';
    return sign + Math.ceil(abs * 100) / 100; // round up to 2 decimals
  }

  function updateExtendedTradeTable() {
    var data = window.eveMineralCompare && eveMineralCompare.extendedTradesData;
    if (!data) return;

    var buyType  = $('#buy-from-select-ext').val()  || 'buy';
    var sellType = $('#sell-to-select-ext').val()   || 'sell';

    // show note only when both legs are synthetic (no ladder)
    var showDefaultNote = (buyType === 'buy' && sellType === 'sell');
    $('#emc-limit-60k-container .emc-limit-note').toggleClass('is-visible', showDefaultNote);

    var allowed  = getAllowedHubsExtended();
    var fees     = getBrokerageAndTaxForHub();
    var taxes    = getSalesTaxForHub();
    var qtyLimit = $('#emc-limit-60k').is(':checked') ? 6000000 : null; // 6,000,000 units (60,000 m³)
    var minMargin= parseFloat($('#emc-min-margin').val());
    if (!Number.isFinite(minMargin)) minMargin = 5;

    var $tbody = $('#eve-mc-extended tbody').empty();
    var margins = [], rows = 0;

    jQuery.each(data, function (id, m) {
      if (!m || !m.hubs || !allowed.length) return;
      var sim = simulateDepthAcrossOrders(m, buyType, sellType, qtyLimit, allowed, fees, taxes, minMargin);
      if (!sim || sim.profit <= 0 || sim.margin < minMargin) return;

      margins.push(sim.margin); rows++;
      $tbody.append(
        '<tr>'+
          '<td>'+(m.name || id)+'</td>'+
          '<td>'+sim.buyHub+'</td>'+
          '<td>'+sim.sellHub+'</td>'+
          '<td class="emc-td-right emc-td-nowrap">'+formatNumber(sim.filledQty)+'</td>'+
          '<td class="emc-td-right emc-td-nowrap">'+formatNumber(sim.profit)+'<div class="emc-subtext"><em>Invest '+emcFormatShortISK(sim.investment)+'</em></div>'+'</td>'+
          '<td class="emc-td-right emc-td-nowrap emc-margin" data-margin="'+sim.margin+'">'+sim.margin.toFixed(2)+'%</td>'+
        '</tr>'
      );
    });

    if (!rows) {
      $tbody.append('<tr><td colspan="6" style="text-align:center;color:#a00;font-weight:bold">No opportunities meet the current filters.</td></tr>');
    }
    
    // After rows built, color the margin cells using the same logic as No-Undock
    var minAll = margins.length ? Math.min.apply(null, margins) : 0;
    var maxAll = margins.length ? Math.max.apply(null, margins) : 0;
    $('#eve-mc-extended td.emc-margin').each(function(){
      var mg = parseFloat(this.getAttribute('data-margin'));
      var color = colorForMargin(mg, minAll, maxAll);
      this.style.color = color;
      this.style.background = 'transparent';
    });
    var el = document.getElementById('eve-mc-extended');
    if (el) {
      el.style.setProperty('--min-margin', String(margins.length ? Math.min.apply(null, margins) : 0));
      el.style.setProperty('--max-margin', String(margins.length ? Math.max.apply(null, margins) : 0));
    }
  }

  // ---------- persist/restore settings ----------
  function restoreStandings() {
    try {
      var raw = localStorage.getItem(LS_STANDINGS);
      if (!raw) return;
      var obj = JSON.parse(raw) || {};
      $('.emc-standing-input').each(function(){
        var key = this.getAttribute('data-standing');
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          var v = Number(obj[key]);
          if (!Number.isFinite(v)) v = 0;
          v = Math.max(-10, Math.min(10, v));
          this.value = v.toFixed(2);
        }
      });
    } catch(e){}
  }
  
  function restoreExtPrefs() {
    try {
      // --- limit toggle ---
      var lim = localStorage.getItem(LS_EXT_LIMIT);
      if (lim !== null) {
        var on = lim === '1';
        $('#emc-limit-60k').prop('checked', on);
      }

      // --- hubs selection ---
      var raw = localStorage.getItem(LS_EXT_HUBS);
      if (raw) {
        var wanted = JSON.parse(raw); // array of values (strings)
        if (Array.isArray(wanted)) {
          // clear first, then check the saved ones that still exist
          $('#emc-hub-filters-best .emc-hub-toggle').each(function () {
            var v = String($(this).val());
            $(this).prop('checked', wanted.indexOf(v) !== -1);
          });
        }
      }
    } catch (e) {}
  }

  // ---------- no-undock trading ----------
  // ---------- helpers for robust scaling ----------
  function emcPercentile(sortedNums, p) {
    if (!sortedNums || !sortedNums.length) return 0;
    var i = (sortedNums.length - 1) * p;
    var lo = Math.floor(i), hi = Math.ceil(i);
    if (lo === hi) return sortedNums[lo];
    var t = i - lo;
    return sortedNums[lo] * (1 - t) + sortedNums[hi] * t;
  }

  var EMC_MAX_REASONABLE_MARGIN = 1000;  // 1000% cap for display/scale
  var EMC_MIN_BUY_FLOOR = 1.0;           // ISK; tweak if needed

  function emcIsOutlierMargin(margin, buy, sell) {
    if (!isFinite(margin) || !isFinite(buy) || !isFinite(sell) || sell <= 0) return true;
    if (Math.abs(margin) > EMC_MAX_REASONABLE_MARGIN) return true;
    if (buy > 0 && buy < EMC_MIN_BUY_FLOOR && sell >= 100 * buy) return true;
    return false;
  }

  function emcRobustBounds(values) {
    var v = (values || []).filter(Number.isFinite).slice().sort(function(a,b){return a-b;});
    if (!v.length) return [-1, 1];
    var p5  = emcPercentile(v, 0.05);
    var p95 = emcPercentile(v, 0.95);
    var span = Math.max(Math.abs(p5), Math.abs(p95), 1);
    return [-span, span];
  }

  // ---------- color scale ----------
  function colorForMargin(margin, minAll, maxAll) {
    var m = toNum(margin);
    if (!isFinite(m)) return '#555';

    // If everything's the same, fall back to sign-based colors
    if (maxAll === minAll) {
      if (m < 0) return '#DB4325';
      if (m > 0) return '#006164';
      return '#B9DCCF';
    }

    if (m < 0) return '#DB4325';
    if (maxAll <= 0) return m === 0 ? '#B9DCCF' : '#DB4325';

    var span = Math.max(1e-9, Math.abs(maxAll));
    var u = Math.min(Math.log1p(m) / Math.log1p(span), 1); // 0..1
    var gamma = 0.6;
    var t = Math.pow(u, gamma);

    var stops = ['#B9DCCF', '#57C4AD', '#006164'];
    var positions = [0, 0.05, 1];

    var i = 0;
    while (i < positions.length - 2 && t > positions[i + 1]) i++;

    var t0 = positions[i], t1 = positions[i + 1];
    var localT = (t - t0) / Math.max(1e-9, (t1 - t0));

    return lerpHex(stops[i], stops[i + 1], localT);

    function toNum(v) {
      if (typeof v === 'string') v = v.trim().replace(/%$/, '');
      var n = parseFloat(v);
      return isNaN(n) ? NaN : n;
    }
    function lerpHex(h1, h2, t) {
      var c1 = hexToRgb(h1), c2 = hexToRgb(h2);
      var r = Math.round(c1.r + (c2.r - c1.r) * t);
      var g = Math.round(c1.g + (c2.g - c1.g) * t);
      var b = Math.round(c1.b + (c2.b - c1.b) * t);
      return rgbToHex(r, g, b);
    }
    function hexToRgb(hex) {
      hex = (hex + '').replace('#', '');
      if (hex.length === 3) hex = hex.split('').map(function(c){ return c + c; }).join('');
      var num = parseInt(hex, 16);
      return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
    }
    function pad2(v) { v = v.toString(16); return v.length === 1 ? '0' + v : v; }
    function rgbToHex(r, g, b) { return ('#' + pad2(r) + pad2(g) + pad2(b)).toUpperCase(); }
  }

  // ---------- format ----------
  function formatPercent(val, isOutlier) {
    if (!isFinite(val)) return 'N/A';
    if (isOutlier) {
      return (val < 0 ? '-' : '+') + EMC_MAX_REASONABLE_MARGIN.toFixed(0) + '%';
    }
    return val.toFixed(2) + '%';
  }

  // ---------- main update ----------
  function updateNoUndockTable() {
    var data = window.eveMineralCompare && eveMineralCompare.extendedTradesData;
    if (!data) return;

    var hubOrder = [];
    $('#emc-no-undock thead tr:first th').each(function (i) {
      if (i === 0) return;
      hubOrder.push($(this).text().trim());
    });
    if (!hubOrder.length) return;

    var brokerageFees = getBrokerageAndTaxForHub();
    var salesTaxes    = getSalesTaxForHub();

    var allMargins = [];
    var byMineral = {};

    jQuery.each(data, function (tid, m) {
      if (!m || !m.hubs) return;
      var row = {};
      hubOrder.forEach(function (hub) {
        var h = m.hubs[hub];
        var buy  = h && h.buy;
        var sell = h && h.sell;
        var margin = NaN;
        var isOut = false;

        if (isFinite(buy) && isFinite(sell)) {
          var bf = Number(brokerageFees[hub] || 0);
          var tx = Number(salesTaxes[hub]    || 0);
          var cost = buy * (1 + bf);
          var rev  = sell * (1 - bf - tx);
          if (cost > 0 && isFinite(rev)) {
            margin = ((rev - cost) / cost) * 100;
            isOut = emcIsOutlierMargin(margin, buy, sell);
            if (!isOut) {
              allMargins.push(margin);
            }
          }
        }
        row[hub] = { margin: margin, outlier: isOut };
      });
      byMineral[m.name || tid] = row;
    });

    var bounds = emcRobustBounds(allMargins);
    var minAll = bounds[0];
    var maxAll = bounds[1];

    var $tbody = $('#emc-no-undock tbody').empty();
    jQuery.each(data, function (tid, m) {
      var name = m && (m.name || tid);
      var $tr = $('<tr/>');
      $('<td/>').text(name || '').appendTo($tr);

      hubOrder.forEach(function (hub) {
        var cell = byMineral[name] ? byMineral[name][hub] : { margin: NaN, outlier: false };
        var mg = cell.margin;
        var isOut = cell.outlier;

        var txt = formatPercent(mg, isOut);
        var $td = $('<td/>')
          .addClass('emc-td-center emc-td-nowrap')
          .text(txt);

        if (!isOut) {
          var color = colorForMargin(mg, minAll, maxAll);
          $td.css('color', color);
        } else {
          $td.css('color', '#555');
        }

        $tr.append($td);
      });

      $tbody.append($tr);
    });
  }

  // ---------- refresh (REST + cooldown + polling) ----------
  function pollForUpdateThenSwap(baselineAgeSec) {
    var started    = Date.now();
    var timeoutMs  = 90 * 1000;
    var intervalMs = 5000;
    var $status    = $('#eve-mineral-status');

    if ($status.length) {
      $status.empty()
        .append($('<strong/>').text('Refresh scheduled…'))
        .append('<br>')
        .append($('<em/>').text('Building market data.'));
      $status.attr('aria-busy', 'true');
    }

    function schedule(next) {
      if (emcPollTimer) clearTimeout(emcPollTimer);
      emcPollTimer = setTimeout(next, intervalMs);
    }

    function tick() {
      if (!eveMineralCompare || !eveMineralCompare.rest) return;
      if (!eveMineralCompare.rest.tradesUrl) return;

      $.getJSON(addCacheBuster(eveMineralCompare.rest.tradesUrl), function(resp){
        var age   = Number(resp && resp.cache_age_seconds);
        var newer = Number.isFinite(age) && (age <= 120 || (Number.isFinite(baselineAgeSec) && age < baselineAgeSec));

        if (newer && eveMineralCompare.rest.snapshotUrl) {
          $.getJSON(addCacheBuster(eveMineralCompare.rest.snapshotUrl), function(snap){
            // If snapshot isn't ready (no real prices yet), keep polling
            if (!isDataReady(snap && snap.extendedTradesData)) {
              if ($status.length) {
                $status.empty()
                  .append($('<strong/>').text('Generating prices…'))
                  .append('<br>')
                  .append($('<em/>').text('This may take a minute or two.'));
                $status.attr('aria-busy', 'true');
              }
              if (Date.now() - started < timeoutMs) schedule(tick);
              return;
            }

            // Ready: swap DOM, init, then announce success with cache age
            if (snap && snap.html) {
              var $root = $('#eve-mineral-compare-tables');
              if ($root.length) {
                $root.replaceWith(snap.html);
                if (snap.extendedTradesData) {
                  eveMineralCompare.extendedTradesData = snap.extendedTradesData;
                }
                robustInit();

                $status = $('#eve-mineral-status');
                if ($status.length) {
                  $status.attr('aria-busy', 'false').empty()
                    .append($('<strong/>').text('Prices updated!'))
                    .append('<br>')
                    .append(document.createTextNode('Cache age: ' + prettyAge(Number(snap.cache_age_seconds))));
                }
              }
            }
          });
          return; // snapshot handler will keep polling if needed
        }

        if (Date.now() - started < timeoutMs) {
          schedule(tick);
        }
      });
    }

    schedule(tick);
  }

  $(document).on('click', '#eve-mineral-refresh', function (e) {
    e.preventDefault();
    var $btn = $(this);
    if ($btn.prop('disabled')) return;

    // Downtime guard: block refresh within 10:55–11:30 UTC
    if (emcIsDowntimeUtc()) {
      emcShowDowntimeMessage();
      return;
    }

    startCooldown($btn, COOLDOWN_SEC);

    var $status = $('#eve-mineral-status');
    $status.attr('aria-busy', 'true').text('Working...');

    // Abort any in-flight
    if (emcRefreshXhr && emcRefreshXhr.readyState !== 4) {
      emcRefreshXhr.abort();
    }

    emcRefreshXhr = $.ajax({
      url: eveMineralCompare.rest && eveMineralCompare.rest.refreshUrl,
      method: 'POST',
      headers: { 'X-WP-Nonce': (eveMineralCompare.rest && eveMineralCompare.rest.nonce) || '' },
      dataType: 'json',
      success: function (resp) {
        if (resp && resp.html) {
          var $root = $('#eve-mineral-compare-tables');
          if ($root.length) { $root.replaceWith(resp.html); }

          // reselect elements after DOM swap
          $status = $('#eve-mineral-status');

          if (resp.extendedTradesData) {
            eveMineralCompare.extendedTradesData = resp.extendedTradesData;
          }
          robustInit();
          if (resp && resp.downtime === true && Array.isArray(resp.downtime_lines)) {
            var $st = $('#eve-mineral-status'); $st.empty();
            if (resp.downtime_lines[0]) $('<span/>', { 'class': 'emc-status-line', text: resp.downtime_lines[0] }).appendTo($st);
            if (resp.downtime_lines[1]) $('<span/>', { 'class': 'emc-status-sub',  text: resp.downtime_lines[1] }).appendTo($st);
          }
    
          if (resp.refreshed) {
            if (resp.partial || resp.used_stale_backup) {
              $status.empty()
                .append($('<strong/>').text('Partial Data Refresh'))
                .append('<br>')
                .append($('<em/>').text('(Some prices updated; some served from cache due to ESI issues)'));
            } else {
              $status.text('Prices updated!');
            }
          } else if (resp.scheduled === true) {
            var sec = Number(resp.cache_age_seconds);
            $status.empty()
              .append($('<strong/>').text('Refresh Scheduled'))
              .append('<br>')
              .append($('<em/>').text('(Refreshing in the background)'))
              .append('<br>')
              .append(document.createTextNode('Current cache age: ' + prettyAge(sec)));
            // Poll ONLY when a refresh was scheduled
            pollForUpdateThenSwap(Number(sec));
          } else if (resp.used_cache === true) {
            var sec2 = Number(resp.cache_age_seconds);
            $status.empty()
              .append($('<strong/>').text('Used Cached Prices'))
              .append('<br>')
              .append($('<em/>').text('(Cache is younger than 6 hours old)'))
              .append('<br>')
              .append(document.createTextNode('Cache age: ' + prettyAge(sec2)));
          } else {
            $status.text('No update performed.');
          }

          if (resp.cache_write_ok === false) {
            $status.append(
              $('<div/>').css({ color:'#a00', fontWeight:'bold', marginTop:'4px' })
                         .text('Warning: cache not writable; data may not persist.')
            );
          }
        } else {
          $status.text('Error refreshing data.');
        }
      },

      error: function (xhr, textStatus) {
        var $st = $('#eve-mineral-status');
        if (textStatus === 'abort') return;
        var msg = 'Network error.';
        if (xhr && xhr.responseJSON && xhr.responseJSON.error) msg = xhr.responseJSON.error;
        else if (xhr && typeof xhr.responseText === 'string' && xhr.responseText.length < 2048) {
          try { var j = JSON.parse(xhr.responseText); if (j && j.error) msg = j.error; } catch(e){}
        }
        $st.text(msg);
      },

      complete: function(){
        $('#eve-mineral-status').attr('aria-busy', 'false');
      }
    });
  });

  // ---------- admin-only clear cache ----------
  function ensureClearCacheStatus($btn) {
    var $status = $('#eve-mineral-clear-cache-status');
    if (!$status.length) {
      $status = $('<div>', {
        id: 'eve-mineral-clear-cache-status',
        class: 'emc-clear-status',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true'
      });
      $btn.after($status);
    } else {
      if (!$status.prev().is($btn)) {
        $status.detach();
        $btn.after($status);
      }
      $status
        .attr('role', 'status')
        .attr('aria-live', 'polite')
        .attr('aria-atomic', 'true')
        .addClass('emc-clear-status');
    }
    function renderTwoLine(line1, line2) {
      $status.empty();
      $('<span/>', { 'class': 'emc-status-line', text: line1 }).appendTo($status);
      $('<span/>', { 'class': 'emc-status-sub',  text: line2 }).appendTo($status);
    }
    return {
      setClearing: function () {
        $status.attr('data-state', 'clearing').empty()
          .append($('<em/>').text('Clearing cache…'));
      },
      setSuccess: function () {
        $status.attr('data-state', 'success');
        renderTwoLine('Cache Cleared', 'Next price pull may take several seconds.');
      },
      setError: function () {
        $status.attr('data-state', 'error').empty()
          .append($('<span/>').text('Error clearing cache.'));
      }
    };
  }

  $(document).on('click', '#eve-mineral-clear-cache', function (e) {
    e.preventDefault();
    var $btn = $(this);
    if ($btn.prop('disabled')) return;
    if (!window.eveMineralCompare || !eveMineralCompare.isAdmin || !eveMineralCompare.rest || !eveMineralCompare.rest.clearCacheUrl) {
      return;
    }

    var statusUI = ensureClearCacheStatus($btn);
    statusUI.setClearing();
    $btn.prop('disabled', true).text('Clearing…');

    $.ajax({
      url: eveMineralCompare.rest.clearCacheUrl,
      method: 'POST',
      headers: { 'X-WP-Nonce': (eveMineralCompare.rest && eveMineralCompare.rest.nonce) || '' },
      dataType: 'json',
      success: function () {
        statusUI.setSuccess();
        if (eveMineralCompare.rest && eveMineralCompare.rest.snapshotUrl) {
          $.getJSON(addCacheBuster(eveMineralCompare.rest.snapshotUrl), function (snap) {
            if (snap && snap.html) {
              var $root = $('#eve-mineral-compare-tables');
              if ($root.length) {
                $root.replaceWith(snap.html);
                if (snap.extendedTradesData) {
                  eveMineralCompare.extendedTradesData = snap.extendedTradesData;
                }
                robustInit();
                var $newBtn = $('#eve-mineral-clear-cache');
                ensureClearCacheStatus($newBtn).setSuccess();
              }
            }
          });
        }
      },
      error: function () {
        ensureClearCacheStatus($btn).setError();
      },
      complete: function () {
        $('#eve-mineral-clear-cache').prop('disabled', false).text('Clear Cache');
      }
    });
  });

  // ---------- cooldown helpers ----------
  function startCooldown($btn, seconds) {
    var until = Date.now() + seconds * 1000;
    try { localStorage.setItem(LS_NEXT_REFRESH_AT, String(until)); } catch(e){}
    applyCooldown($btn, until);
  }

  function applyCooldown($btn, untilTs) {
    var remaining = Math.max(0, Math.ceil((untilTs - Date.now()) / 1000));
    if (remaining <= 0) {
      $btn.prop('disabled', false).text('Refresh Prices');
      return;
    }
    $btn.prop('disabled', true).text('Refresh Prices (' + remaining + 's)');
    var timer = setInterval(function(){
      remaining--;
      if (remaining <= 0) {
        clearInterval(timer);
        $btn.prop('disabled', false).text('Refresh Prices');
        try { localStorage.removeItem(LS_NEXT_REFRESH_AT); } catch(e){}
      } else {
        $btn.text('Refresh Prices (' + remaining + 's)');
      }
    }, 1000);
  }

  function emcSyncRefreshButton() {
    var $btn = $('#eve-mineral-refresh');
    if (!$btn.length) return;
    var until = null;
    try {
      var raw = localStorage.getItem(LS_NEXT_REFRESH_AT);
      if (raw) until = parseInt(raw, 10);
    } catch(e){}
    if (until && until > Date.now()) {
      applyCooldown($btn, until);
    } else {
      $btn.prop('disabled', false).text('Refresh Prices');
    }
  }

  // ---------- sync across tabs ----------
  window.addEventListener('storage', function (e) {
    if (e.key === LS_NEXT_REFRESH_AT) {
      emcSyncRefreshButton();
    }
    if (e.key === LS_STANDINGS) {
      restoreStandings();
      updateEffectiveStandings();
      updateFeesDisplay();
      restoreExtPrefs();
    }
    // NEW: live-sync the extended prefs too
    if (e.key === LS_EXT_LIMIT || e.key === LS_EXT_HUBS) {
      restoreExtPrefs();
      updateExtendedTradeTable();
    }
  });

  // ---------- lazy-load extended trade data ----------
  function loadTradesThenRender() {
    if (!eveMineralCompare || !eveMineralCompare.rest || !eveMineralCompare.rest.tradesUrl) return;
    $.getJSON(addCacheBuster(eveMineralCompare.rest.tradesUrl), function(resp){
      if (resp && resp.extendedTradesData) {
        eveMineralCompare.extendedTradesData = resp.extendedTradesData;
        updateExtendedTradeTable();
        updateNoUndockTable();
      }
    });
  }

  // ---------- robust init ----------
  function robustInit() {
    // defaults
    $('.emc-skill-select').each(function(){ if (!this.value) this.value = '5'; });
    if (!$('#emc-min-margin').val()) $('#emc-min-margin').val('5');

    // restore standings BEFORE fee calc and render live effective
    restoreStandings();
    updateEffectiveStandings();
    restoreExtPrefs();

    // restore dropdown choices BEFORE any table calculations
    var savedBuy = null, savedSell = null;
    try {
      savedBuy  = localStorage.getItem(LS_BUY_FROM);
      savedSell = localStorage.getItem(LS_SELL_TO);
    } catch(e){}

    if (savedBuy)  $('#buy-from-select-ext').val(savedBuy);
    if (savedSell) $('#sell-to-select-ext').val(savedSell);

    if (!$('#buy-from-select-ext').val())  $('#buy-from-select-ext').val('buy');
    if (!$('#sell-to-select-ext').val())   $('#sell-to-select-ext').val('sell');

    // Insert admin-only Clear Cache button
    try {
      if (
        window.eveMineralCompare &&
        eveMineralCompare.isAdmin &&
        eveMineralCompare.rest &&
        eveMineralCompare.rest.clearCacheUrl
      ) {
        var $refresh = $('#eve-mineral-refresh');
        if ($refresh.length && !$('#eve-mineral-clear-cache').length) {
          var cls = ($refresh.attr('class') || '') + ' emc-clear-btn';
          var $clear = $('<button type="button" id="eve-mineral-clear-cache" aria-label="Clear EVE mineral cache">Clear Cache</button>')
            .attr('class', cls);
          $refresh.after($clear);
          if (!$('#eve-mineral-clear-cache-status').length) {
            $clear.after('<div id="eve-mineral-clear-cache-status" class="emc-clear-status" role="status" aria-live="polite"></div>');
          }
        }
      }
    } catch (e) {}

    var tries = 0, maxTries = 25;
    var t = setInterval(function () {
      tries++;
      var hasData   = !!(window.eveMineralCompare && eveMineralCompare.extendedTradesData && Object.keys(eveMineralCompare.extendedTradesData).length);
      var hasInputs = $('#eve-mineral-user-inputs .emc-skill-select').length > 0;
      var feesDrawn = $('#emc-fees-summary tbody').length > 0;

      if (hasInputs) {
        updateEffectiveStandings();
      }
      if (hasInputs && (!feesDrawn || !$('#emc-fees-summary tbody tr').length)) {
        updateFeesDisplay();
      }

      if (hasData && hasInputs && $('#emc-fees-summary tbody tr').length) {
        clearInterval(t);
        setTimeout(updateExtendedTradeTable, 20);
        setTimeout(updateNoUndockTable, 20);
        emcSyncRefreshButton();
      } else if (tries >= maxTries) {
        clearInterval(t);
        updateFeesDisplay();
        setTimeout(updateExtendedTradeTable, 20);
        setTimeout(updateNoUndockTable, 20);
        emcSyncRefreshButton();
      }
    }, 120);

    loadTradesThenRender();

    // Initialize Off-Hub calculator (bottom table)
    initOffHubCalculator();
  }

  // first mount
  robustInit();

  // ---------- reactive events ----------
  $(document).on('change', '#buy-from-select-ext', function () {
    try { localStorage.setItem(LS_BUY_FROM, this.value); } catch (e) {}
    updateExtendedTradeTable();
  });
  $(document).on('change', '#sell-to-select-ext', function () {
    try { localStorage.setItem(LS_SELL_TO, this.value); } catch (e) {}
    updateExtendedTradeTable();
  });
  // limit toggle
  $(document).on('change', '#emc-limit-60k', function () {
    try { localStorage.setItem(LS_EXT_LIMIT, this.checked ? '1' : '0'); } catch(e){}
    updateExtendedTradeTable();
  });

  // hub checkboxes
  $(document).on('change', '.emc-hub-toggle', function () {
    try {
      var sel = $('#emc-hub-filters-best .emc-hub-toggle:checked')
        .map(function(){ return String($(this).val()); }).get();
      localStorage.setItem(LS_EXT_HUBS, JSON.stringify(sel));
    } catch(e){}
    updateExtendedTradeTable();
  });
  $(document).on('input',  '#emc-min-margin', debounce(updateExtendedTradeTable, 200));

  // Live updates for skills & standings (no clamp while typing)
  $(document).on('input change', '.emc-skill-select, .emc-standing-input', debounce(function () {
    updateEffectiveStandings();
    updateFeesDisplay();
    // Save raw (clamped on blur separately)
    try {
      var all = {};
      $('.emc-standing-input').each(function(){
        var key = this.getAttribute('data-standing');
        var raw = String($(this).val() || '').replace(',', '.').trim();
        var v = parseFloat(raw);
        all[key] = Number.isFinite(v) ? v : 0;
      });
      // FIX: use key constant consistently
      localStorage.setItem(LS_STANDINGS, JSON.stringify(all));
    } catch(e){}
  }, 150));

  // ---------- cleanup on unload ----------
  window.addEventListener('beforeunload', function () {
    if (emcPollTimer) clearTimeout(emcPollTimer);
    if (emcRefreshXhr && emcRefreshXhr.readyState !== 4) {
      try { emcRefreshXhr.abort(); } catch(e){}
    }
  });

  // ensure initial compute with empty-as-zero values
  try { updateEffectiveStandings(); updateFeesDisplay(); } catch (e) {}
});


/* ==================================================================
   PERSISTENCE (non-invasive): Min Margin + Off-Hub controls & rows
   - Keeps original numeric behavior intact
   - Loads after tables render, then triggers existing calculations
   ================================================================== */
(function($){
  'use strict';

  // LocalStorage keys
  var LS_MIN_MARGIN = 'emcMinMargin';
  var LS_ADV_BROKER = 'emcAdvBroker';
  var LS_ADV_TAX    = 'emcAdvTax';
  var LS_ADV_ROWS   = 'emcAdvRows';       // { buys:[], sells:[] }
  var LS_ADV_TOGGLES= 'emcAdvToggles';    // { buyBroker:Boolean, sellBroker:Boolean, sellTax:Boolean }
  // NOTE: LS_EXT_HUBS and LS_EXT_LIMIT are defined in the top-level scope

  // Ensure our targets also get the plugin's decimal filtering
  $(function(){
    $('#emc-min-margin, #emc-adv-brokerage, #emc-adv-tax, .emc-adv-input').addClass('emc-decimal-only');
  });

  // Minimal decimal-only filter for our fields (does not touch other logic)
  $(document).on('input', '#emc-min-margin, #emc-adv-brokerage, #emc-adv-tax, .emc-adv-input', function () {
    var v = String($(this).val() || '');
    v = v.replace(',', '.');                 // comma -> dot
    v = v.replace(/[^0-9.\-]/g, '');         // strip non-numeric
    var firstDot = v.indexOf('.');
    if (firstDot !== -1) {
      v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
    }
    // leading minus only if min < 0 (most of these are min=0, so strip minus)
    if (this.getAttribute('min') === '0') {
      v = v.replace(/^\-+/, '');
    } else {
      // keep a single leading minus
      v = v.replace(/\-(?=.*\-)/g, '');
    }
    if (v.startsWith('.')) v = '0' + v;
    $(this).val(v);
  });

  function saveMinMargin() {
    try {
      var v = String($('#emc-min-margin').val() || '').replace(',', '.');
      var n = parseFloat(v);
      if (Number.isFinite(n)) localStorage.setItem(LS_MIN_MARGIN, String(n));
    } catch(e){}
  }

  function loadMinMargin() {
    try {
      var v = localStorage.getItem(LS_MIN_MARGIN);
      if (v !== null && v !== '') $('#emc-min-margin').val(v);
    } catch(e){}
  }

  function saveAdv() {
    try {
      var b = parseFloat(String($('#emc-adv-brokerage').val() || '').replace(',', '.'));
      var t = parseFloat(String($('#emc-adv-tax').val() || '').replace(',', '.'));
      if (Number.isFinite(b)) localStorage.setItem(LS_ADV_BROKER, String(b)); else localStorage.removeItem(LS_ADV_BROKER);
      if (Number.isFinite(t)) localStorage.setItem(LS_ADV_TAX, String(t));   else localStorage.removeItem(LS_ADV_TAX);
    } catch(e){}

    try {
      var buys = [], sells = [];
      $('#emc-adv-table tbody tr').each(function(){
        var $row = $(this);
        var bv = String($row.find('.emc-adv-buy').val() || '').replace(',', '.');
        var sv = String($row.find('.emc-adv-sell').val() || '').replace(',', '.');
        var bn = parseFloat(bv); buys.push(Number.isFinite(bn) ? String(bn) : '');
        var sn = parseFloat(sv); sells.push(Number.isFinite(sn) ? String(sn) : '');
      });
      localStorage.setItem(LS_ADV_ROWS, JSON.stringify({buys:buys, sells:sells}));
    } catch(e){}

    try {
      var tgl = {
        buyBroker:  !!document.getElementById('emc-adv-buy-broker')?.checked,
        sellBroker: !!document.getElementById('emc-adv-sell-broker')?.checked,
        sellTax:    !!document.getElementById('emc-adv-sell-tax')?.checked
      };
      localStorage.setItem(LS_ADV_TOGGLES, JSON.stringify(tgl));
    } catch(e){}
  }

  function loadAdv() {
    try {
      var b = localStorage.getItem(LS_ADV_BROKER);
      var t = localStorage.getItem(LS_ADV_TAX);
      if (b !== null && b !== '') $('#emc-adv-brokerage').val(b);
      if (t !== null && t !== '') $('#emc-adv-tax').val(t);
    } catch(e){}

    try {
      var raw = localStorage.getItem(LS_ADV_ROWS);
      if (raw) {
        var rows = JSON.parse(raw);
        var i = 0;
        $('#emc-adv-table tbody tr').each(function(){
          var $row = $(this);
          if (rows.buys && rows.buys[i] !== undefined)  $row.find('.emc-adv-buy').val(rows.buys[i]);
          if (rows.sells && rows.sells[i] !== undefined) $row.find('.emc-adv-sell').val(rows.sells[i]);
          i++;
        });
      }
    } catch(e){}

    try {
      var rawT = localStorage.getItem(LS_ADV_TOGGLES);
      if (rawT) {
        var tgl = JSON.parse(rawT);
        if (typeof tgl.buyBroker  === 'boolean') $('#emc-adv-buy-broker').prop('checked', tgl.buyBroker);
        if (typeof tgl.sellBroker === 'boolean') $('#emc-adv-sell-broker').prop('checked', tgl.sellBroker);
        if (typeof tgl.sellTax    === 'boolean') $('#emc-adv-sell-tax').prop('checked', tgl.sellTax);
      }
    } catch(e){}
  }

  // Save on user interactions
  $(document).on('input change', '#emc-min-margin', saveMinMargin);
  $(document).on('input change', '#emc-adv-brokerage, #emc-adv-tax, .emc-adv-input', saveAdv);
  $(document).on('change',       '#emc-adv-buy-broker, #emc-adv-sell-broker, #emc-adv-sell-tax', saveAdv);

  // Load AFTER plugin renders tables and binds its own events,
  // then trigger inputs so existing calculation logic runs.
  $(window).on('load', function(){
    function ready(){
      return $('#emc-adv-table tbody tr').length > 0;
    }
    var tries = 0;
    (function wait(){
      if (ready()) {
        loadMinMargin();
        loadAdv();
        // trigger recalculation hooks already defined by the plugin
        $('#emc-min-margin').trigger('input');
        $('#emc-adv-brokerage, #emc-adv-tax, .emc-adv-input').trigger('input');
        $('#emc-adv-buy-broker, #emc-adv-sell-broker, #emc-adv-sell-tax').trigger('change');
        return;
      }
      tries++;
      if (tries < 60) setTimeout(wait, 50);
    })();
  });

})(jQuery);

/* === Auto-calc Brokerage Fee & Sales Tax on load === */
(function($){
  $(window).on('load', function(){
    try { updateEffectiveStandings(); } catch(e){}
    try { updateFeesDisplay(); } catch(e){}
  });
})(jQuery);

/* === Clear All also clears persisted Off-Hub values === */
(function($){
  var ADV_KEYS = ['emcAdvBroker','emcAdvTax','emcAdvRows','emcAdvToggles'];
  $(document).on('click', '#emc-adv-clear', function(){
    try { ADV_KEYS.forEach(function(k){ localStorage.removeItem(k); }); } catch(e){}
  });
})(jQuery);

/* === Prevent duplicate Off-Hub sections after refresh === */
(function(){
  function dedupe(){
    var list = document.querySelectorAll('.emc-adv-container');
    for (var i = 1; i < list.length; i++) list[i].remove();
  }
  var run = function(){ requestAnimationFrame(dedupe); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, {once:true}); else run();
  if ('MutationObserver' in window) new MutationObserver(run).observe(document.body, {childList:true, subtree:true});
  document.addEventListener('click', function(e){
    var t = e.target;
    if (t && (t.id === 'eve-mineral-refresh' || t.classList.contains('emc-refresh-btn'))) {
      setTimeout(run, 30); setTimeout(run, 120);
    }
  }, true);
})();

/* === Auto-select all text on focus for base standings === */
(function($){
  $(document).on('focus', '.emc-standing-input', function(){
    var el = this;
    setTimeout(function(){ try { el.select(); } catch(e){} }, 0);
  });
})(jQuery);

// Inject subtle subtext style for profit cell investment line
(function ensureEtoStyles(){
  try {
    var id = 'emc-subtext-style';
    if (document.getElementById(id)) return;
    var css = '.emc-subtext{font-size:11px;line-height:1.2;color:#666;margin-top:2px;}';
    var el = document.createElement('style');
    el.id = id; el.type = 'text/css';
    el.appendChild(document.createTextNode(css));
    document.head.appendChild(el);
  } catch(e){}
})();
