/* global jQuery, eveMineralCompare */
jQuery(function ($) {
  var ASSUMED_UNITS = 100000;      // pseudo cap for single-price legs
  var emcRefreshXhr = null;        // tracks the current REST request
  var COOLDOWN_SEC = 20;           // forced 20s cooldown animation
  var LS_NEXT_REFRESH_AT = 'emcNextRefreshAt';
  var LS_BUY_FROM  = 'emcBuyFrom';
  var LS_SELL_TO   = 'emcSellTo';
  var LS_STANDINGS = 'emcStandings';

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
  // Applies rules:
  // BUY from buy: brokerage ADDED; price uses min(highest buys across hubs)  → synthetic
  // BUY from sell: no fee;      price uses min(lowest sells across hubs)     → ladder
  // SELL to buy:   tax only;    price uses max(highest buys across hubs)     → ladder
  // SELL to sell:  tax + broker;price uses max(highest sells across hubs)    → synthetic
  // Uses full orderbook ladders for any leg set to match live orders (buy from sell / sell to buy)
  function simulateDepthAcrossOrders(mineral, buyType, sellType, qtyLimit, allowedHubs, brokerageFees, salesTaxRates, minMarginPct) {
    if (!mineral || !mineral.hubs) return null;

    var MAX_SAFE_TOTAL = 1e15; // cap for running totals (cost/revenue)
    var MAX_QTY_CAP    = 1e5;  // guardrail ONLY for non-ladder scenarios (100k)

    // BUYING hub/price pick
    var buyBest = (buyType === 'buy')
      ? pickHub(mineral, 'buy',  'min', allowedHubs)   // creating a buy order (synthetic)
      : pickHub(mineral, 'sell', 'min', allowedHubs);  // instant buy (fulfilling sell ladder)

    // SELLING hub/price pick
    var sellBest = (sellType === 'buy')
      ? pickHub(mineral, 'buy',  'max', allowedHubs)   // instant sell (fulfilling buy ladder)
      : pickHub(mineral, 'sell', 'max', allowedHubs);  // creating a sell order (synthetic)

    if (!buyBest || !sellBest) return null;

    var buyHub  = buyBest.hub;
    var sellHub = sellBest.hub;

    var buyUsesLadder  = (buyType  === 'sell'); // buying FROM sell orders -> ladder
    var sellUsesLadder = (sellType === 'buy');  // selling INTO buy orders -> ladder
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

    // Quantity ceiling:
    // - If userQtyLimit: min(limit, ladder depth) when ladder is used; else min(limit, MAX_QTY_CAP)
    // - If no userQtyLimit and any ladder: ladder depth (>0)
    // - If no ladders: ASSUMED_UNITS (guarded by MAX_QTY_CAP)
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
      qtyCeiling = ladderBound; // no MAX_QTY_CAP when a ladder is involved
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

    // Final max units; only guard with MAX_QTY_CAP when NO ladder is used
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
      if (newCost > MAX_SAFE_TOTAL || newRev > MAX_SAFE_TOTAL) break;

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
    return { buyHub: buyHub, sellHub: sellHub, filledQty: filled, profit: profit, margin: margin };
  }

  // ---------- effective standings UI ----------
  function updateEffectiveStandings() {
    var connections = +$('.emc-skill-select[data-skill="connections"]').val() || 0;
    var diplomacy   = +$('.emc-skill-select[data-skill="diplomacy"]').val() || 0;
    $('.emc-standing-input').each(function () {
      var base = Math.min(10, Math.max(-10, +$(this).val() || 0));
      $(this).val(base);
      $(this).closest('tr')
        .find('.emc-effective-standing')
        .text(calcEffectiveStanding(base, connections, diplomacy).toFixed(2));
    });
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
  function updateExtendedTradeTable() {
    var data = window.eveMineralCompare && eveMineralCompare.extendedTradesData;
    if (!data) return;

    var buyType  = $('#buy-from-select-ext').val()  || 'buy';
    var sellType = $('#sell-to-select-ext').val()   || 'sell';
    // show note only when both legs are synthetic (no ladder)
    var showDefaultNote = (buyType === 'buy' && sellType === 'sell');
    $('#emc-limit-60k-container .emc-limit-note')
        .toggleClass('is-visible', showDefaultNote);
    var allowed  = getAllowedHubsExtended();
    var fees     = getBrokerageAndTaxForHub();
    var taxes    = getSalesTaxForHub();
    var qtyLimit = $('#emc-limit-60k').is(':checked') ? 6000000 : null; // 6,000,000 units (≈ 60,000 m³)
    var minMargin= parseFloat($('#emc-min-margin').val());
    if (!Number.isFinite(minMargin)) minMargin = 5;

    var $tbody = $('#eve-mc-extended tbody').empty();
    var margins = [], rows = 0;

    // data is an object keyed by type_id
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
          '<td class="emc-td-right emc-td-nowrap">'+formatNumber(sim.profit)+'</td>'+
          '<td class="emc-td-right emc-td-nowrap emc-margin" style="--margin:'+sim.margin+'">'+sim.margin.toFixed(2)+'%</td>'+
        '</tr>'
      );
    });

    if (!rows) {
      $tbody.append('<tr><td colspan="6" style="text-align:center;color:#a00;font-weight:bold">No opportunities meet the current filters.</td></tr>');
    }

    var el = document.getElementById('eve-mc-extended');
    if (el) {
      el.style.setProperty('--min-margin', String(margins.length ? Math.min.apply(null, margins) : 0));
      el.style.setProperty('--max-margin', String(margins.length ? Math.max.apply(null, margins) : 0));
    }
  }

  // ---------- persist/restore standings ----------
  function restoreStandings() {
    try {
      var raw = localStorage.getItem(LS_STANDINGS);
      if (!raw) return;
      var obj = JSON.parse(raw) || {};
      $('.emc-standing-input').each(function(){
        var key = this.getAttribute('data-standing');
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          var v = Number(obj[key]);
          this.value = Number.isFinite(v) ? Math.max(-10, Math.min(10, v)) : 0;
        }
      });
    } catch(e){}
  }
  
    // ---------- no-undock trading (Table 4) ----------
    function colorForMargin(margin, minAll, maxAll) {
      // Non-finite → muted gray
      if (!isFinite(margin)) return '#555';
    
      // If everything is the same, pick a neutral greenish
      if (maxAll === minAll) return margin >= 0 ? '#1b5e20' : '#b00020';
    
      if (margin <= 0) {
        // Scale reds from 0% (light) to minAll (deep red)
        var tR = (minAll < 0) ? Math.min(1, Math.max(0, (0 - margin) / (0 - minAll))) : 1;
        var lR = 55 - 20 * tR; // lightness 55% → 35%
        return 'hsl(0, 80%,' + lR + '%)'; // red hues
      } else {
        // Scale greens from small positive → maxAll (deep green)
        var tG = (maxAll > 0) ? Math.min(1, Math.max(0, margin / maxAll)) : 0;
        var lG = 50 - 25 * tG; // lightness 50% → 25%
        return 'hsl(145, 60%,' + lG + '%)'; // green hues
      }
    }
    
    function formatPercent(val) {
      return (isFinite(val) ? val.toFixed(2) + '%' : 'N/A');
    }
    
    function updateNoUndockTable() {
      var data = window.eveMineralCompare && eveMineralCompare.extendedTradesData;
      if (!data) return;
    
      // Read hub order from the table header so columns always match DOM
      var hubOrder = [];
      $('#emc-no-undock thead tr:first th').each(function (i) {
        if (i === 0) return; // skip "Mineral"
        hubOrder.push($(this).text().trim());
      });
      if (!hubOrder.length) return;
    
      // Fees per hub (built from current skills/standings)
      var brokerageFees = getBrokerageAndTaxForHub(); // hub -> fee
      var salesTaxes    = getSalesTaxForHub();        // hub -> tax
    
      // Gather all margins first to compute global min/max for color scaling
      var allMargins = [];
    
      // Precompute margins: { mineralName: { hubName: margin } }
      var byMineral = {};
    
      jQuery.each(data, function (tid, m) {
        if (!m || !m.hubs) return;
        var row = {};
        hubOrder.forEach(function (hub) {
          var h = m.hubs[hub];
          var buy  = h && h.buy;
          var sell = h && h.sell;
    
          var margin = NaN;
          if (isFinite(buy) && isFinite(sell)) {
            var bf = Number(brokerageFees[hub] || 0);
            var tx = Number(salesTaxes[hub]    || 0);
            // Cost: placing a BUY order (brokerage added)
            var cost = buy * (1 + bf);
            // Revenue: placing a SELL order (brokerage + tax removed)
            var rev  = sell * (1 - bf - tx);
            if (cost > 0 && isFinite(rev)) {
              margin = ((rev - cost) / cost) * 100;
              allMargins.push(margin);
            }
          }
          row[hub] = margin;
        });
        byMineral[m.name || tid] = row;
      });
    
      var minAll = allMargins.length ? Math.min.apply(null, allMargins) : 0;
      var maxAll = allMargins.length ? Math.max.apply(null, allMargins) : 0;
    
      // Build tbody
      var $tbody = $('#emc-no-undock tbody').empty();
    
      // Keep mineral order consistent with Extended data insertion order
      jQuery.each(data, function (tid, m) {
        var name = m && (m.name || tid);
        var cells = '';
        hubOrder.forEach(function (hub) {
          var mg = byMineral[name] ? byMineral[name][hub] : NaN;
          var color = colorForMargin(mg, minAll, maxAll);
          var txt = formatPercent(mg);
          cells += '<td class="emc-td-center emc-td-nowrap" style="color:'+color+'">'+txt+'</td>';
        });
        $tbody.append('<tr><td>'+ (name || '') +'</td>'+cells+'</tr>');
      });
    }

  // ---------- events ----------
  $(document).on('change', '#buy-from-select-ext', function () {
    try { localStorage.setItem(LS_BUY_FROM, this.value); } catch (e) {}
    updateExtendedTradeTable();
  });
  $(document).on('change', '#sell-to-select-ext', function () {
    try { localStorage.setItem(LS_SELL_TO, this.value); } catch (e) {}
    updateExtendedTradeTable();
  });

  // other controls that trigger a table update
  $(document).on('change', '#emc-limit-60k, .emc-hub-toggle', updateExtendedTradeTable);
  $(document).on('input',  '#emc-min-margin', debounce(updateExtendedTradeTable, 200));

  // skills & standings recalc
  $(document).on('change', '.emc-skill-select', function () {
    updateEffectiveStandings();
    updateFeesDisplay();
  });

  $(document).on('input', '.emc-standing-input', debounce(function () {
    updateEffectiveStandings();
    updateFeesDisplay();
    // persist standings
    try {
      var all = {};
      $('.emc-standing-input').each(function(){
        var key = this.getAttribute('data-standing');
        var v = parseFloat(this.value);
        all[key] = Number.isFinite(v) ? Math.max(-10, Math.min(10, v)) : 0;
      });
      localStorage.setItem(LS_STANDINGS, JSON.stringify(all));
    } catch(e){}
  }, 200));

  // ---------- refresh click via REST (cooldown + server cache-age message) ----------
  $(document).on('click', '#eve-mineral-refresh', function (e) {
    e.preventDefault();

    var $btn = $(this);
    if ($btn.prop('disabled')) return;

    // start cooldown immediately & persist end time
    startCooldown($btn, COOLDOWN_SEC);

    var $status = $('#eve-mineral-status');
    $status.attr('aria-busy', 'true').text('Working...');

    // abort any in-flight
    if (emcRefreshXhr && emcRefreshXhr.readyState !== 4) {
      emcRefreshXhr.abort();
    }

    emcRefreshXhr = $.ajax({
      url: eveMineralCompare.rest.refreshUrl,
      method: 'POST',
      dataType: 'json',

      success: function (resp) {
        if (resp && resp.html) {
          $('#eve-mineral-compare-tables').replaceWith(resp.html);
          if (resp.extendedTradesData) {
            eveMineralCompare.extendedTradesData = resp.extendedTradesData;
          }
          robustInit();

          if (resp.refreshed) {
            if (resp.partial || resp.used_stale_backup) {
              $status.html(
                '<strong>Partial Data Refresh</strong><br>' +
                '<em>(Some prices updated; some served from cache due to ESI issues)</em>'
              );
            } else {
              $status.text('Prices updated!');
            }
          } else if (resp.used_cache) {
            var sec = Number(resp.cache_age_seconds);
            var ageText = 'unknown';
            if (Number.isFinite(sec) && sec >= 0) {
              var h = Math.floor(sec / 3600);
              var m = Math.floor((sec % 3600) / 60);
              if (h > 0) {
                ageText = h + ' hour' + (h === 1 ? '' : 's') + ' ' +
                          m + ' minute' + (m === 1 ? '' : 's');
              } else {
                ageText = m + ' minute' + (m === 1 ? '' : 's');
              }
            }
            $status.html(
              '<strong>Used Cached Prices</strong><br>' +
              '<em>(Cache is younger than 6 hours old)</em><br>' +
              'Cache age: ' + ageText
            );
          } else {
            $status.text('No update performed.');
          }

          if (resp.cache_write_ok === false) {
            $status.append('<div style="color:#a00;font-weight:bold;margin-top:4px">Warning: cache not writable; data may not persist.</div>');
          }
        } else {
          $status.text('Error refreshing data.');
        }
      },

      error: function (xhr, textStatus) {
        if (textStatus === 'abort') return;
        $('#eve-mineral-status').text('Network error.');
      },

      complete: function(){
        $status.attr('aria-busy', 'false');
      }
    });
  });

  // ---------- cooldown helpers (persisted across DOM refresh via localStorage) ----------
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

  // Sync cooldown & standings across tabs
  window.addEventListener('storage', function (e) {
    if (e.key === LS_NEXT_REFRESH_AT) {
      emcSyncRefreshButton();
    }
    if (e.key === LS_STANDINGS) {
      restoreStandings();
      updateEffectiveStandings();
      updateFeesDisplay();
    }
  });

  // ---------- robust init ----------
  function robustInit() {
    // defaults
    $('.emc-skill-select').each(function(){ if (!this.value) this.value = '5'; });
    $('#emc-min-margin').val($('#emc-min-margin').val() || '5');

    // restore standings BEFORE fee calc
    restoreStandings();

    // restore dropdown choices BEFORE any table calculations
    var savedBuy = null, savedSell = null;
    try {
      savedBuy  = localStorage.getItem(LS_BUY_FROM);
      savedSell = localStorage.getItem(LS_SELL_TO);
    } catch(e){}

    if (savedBuy)  $('#buy-from-select-ext').val(savedBuy);
    if (savedSell) $('#sell-to-select-ext').val(savedSell);

    // if nothing saved, ensure sane defaults (buy-from=buy, sell-to=sell)
    if (!$('#buy-from-select-ext').val())  $('#buy-from-select-ext').val('buy');
    if (!$('#sell-to-select-ext').val())   $('#sell-to-select-ext').val('sell');

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
        emcSyncRefreshButton(); // re-apply cooldown after DOM swap
      } else if (tries >= maxTries) {
        clearInterval(t);
        updateFeesDisplay();
        setTimeout(updateExtendedTradeTable, 20);
        setTimeout(updateNoUndockTable, 20);
        emcSyncRefreshButton();
      }
    }, 120);
  }

  // first mount
  robustInit();
});
