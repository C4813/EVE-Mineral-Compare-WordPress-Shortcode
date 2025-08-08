/* global jQuery, eveMineralCompare */
jQuery(function ($) {
  var ASSUMED_UNITS = 100000;      // pseudo cap for single-price legs
  var emcRefreshXhr = null;        // tracks the current AJAX request
  var COOLDOWN_SEC = 10;
  var LS_NEXT_REFRESH_AT = 'emcNextRefreshAt';

  // ---------- utils ----------
  function formatNumber(val) {
    if (val === null || val === undefined || val === 'N/A') return 'N/A';
    var n = Number(val);
    if (!isFinite(n)) return 'N/A';
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
  // EVE-style effective standing blend (approximation you previously used)
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

  // Sales tax w/ Accounting (you used 7.5% base with -11%/lvl)
  function calcSalesTax(accountingLevel) {
    return 0.075 * (1 - (0.11 * (Number(accountingLevel) || 0)));
  }

  // Broker fee w/ Broker Relations + standings
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
      if (!isNaN(fee)) fees[hub] = fee / 100;
    });
    return fees;
  }
  function getSalesTaxForHub() {
    var taxes = {};
    $('#emc-fees-summary tbody tr').each(function () {
      var $c = $(this).find('td');
      var hub = $c.eq(0).text().trim();
      var tax = parseFloat($c.eq(2).text().replace('%', ''));
      if (!isNaN(tax)) taxes[hub] = tax / 100;
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

    $.each(mineral.hubs, function (hubName, hv) {
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
  // Applies rules you specified:
  // BUY from buy: brokerage ADDED; price uses min(highest buys across hubs)
  // BUY from sell: no fee;      price uses min(lowest sells across hubs)
  // SELL to buy:   tax only;    price uses max(highest buys across hubs)
  // SELL to sell:  tax + broker;price uses max(highest sells across hubs)
  // Uses ladders for the legs that match orderbook (buy from sell / sell to buy)
  function simulateDepthAcrossOrders(mineral, buyType, sellType, qtyLimit, allowedHubs, brokerageFees, salesTaxRates, minMarginPct) {
    if (!mineral || !mineral.hubs) return null;

    // BUYING:
    var buyBest = (buyType === 'buy')
      ? pickHub(mineral, 'buy',  'min', allowedHubs)
      : pickHub(mineral, 'sell', 'min', allowedHubs);

    // SELLING:
    var sellBest = (sellType === 'buy')
      ? pickHub(mineral, 'buy',  'max', allowedHubs)
      : pickHub(mineral, 'sell', 'max', allowedHubs);

    if (!buyBest || !sellBest) return null;

    var buyHub  = buyBest.hub;
    var sellHub = sellBest.hub;

    var buyUsesLadder  = (buyType  === 'sell'); // buying FROM existing sell orders
    var sellUsesLadder = (sellType === 'buy');  // selling INTO existing buy orders

    var rawBuyOrders  = buyUsesLadder  ? (mineral.hubs[buyHub] && mineral.hubs[buyHub].sell_orders || []) : [];
    var rawSellOrders = sellUsesLadder ? (mineral.hubs[sellHub] && mineral.hubs[sellHub].buy_orders || []) : [];

    var buyOrders = rawBuyOrders
      .map(function(o){ return ({ price: Number(o.price), vol: Number(o.vol) }); })
      .filter(function(o){ return isFinite(o.price) && o.price > 0 && isFinite(o.vol) && o.vol > 0; });

    var sellOrders = rawSellOrders
      .map(function(o){ return ({ price: Number(o.price), vol: Number(o.vol) }); })
      .filter(function(o){ return isFinite(o.price) && o.price > 0 && isFinite(o.vol) && o.vol > 0; });

    var cap = (qtyLimit != null && isFinite(qtyLimit)) ? Number(qtyLimit) : ASSUMED_UNITS;

    if (!buyUsesLadder) {
      var p = Number(buyBest.price);
      if (!isFinite(p) || p <= 0) return null;
      buyOrders = [{ price: p, vol: cap }];
    }
    if (!sellUsesLadder) {
      var sp = Number(sellBest.price);
      if (!isFinite(sp) || sp <= 0) return null;
      sellOrders = [{ price: sp, vol: cap }];
    }

    if (buyUsesLadder)  buyOrders.sort(function(a,b){ return a.price - b.price; }); // cheapest sells first
    if (sellUsesLadder) sellOrders.sort(function(a,b){ return b.price - a.price; }); // highest buys first

    var maxUnits = (qtyLimit == null) ? cap : Number(qtyLimit);
    if (!isFinite(maxUnits) || maxUnits <= 0) maxUnits = ASSUMED_UNITS;

    var buyFee   = Number(brokerageFees[buyHub]  || 0);
    var sellFee  = Number(brokerageFees[sellHub] || 0);
    var tax      = Number(salesTaxRates[sellHub] || 0);
    var minMargin = Number(minMarginPct || 0);

    var filled = 0, totalCost = 0, totalRevenue = 0;
    var bi = 0, si = 0;

    while (filled < maxUnits && bi < buyOrders.length && si < sellOrders.length) {
      var stepQty = Math.min(buyOrders[bi].vol, sellOrders[si].vol, maxUnits - filled);
      if (!isFinite(stepQty) || stepQty <= 0) break;

      var buyPrice  = buyOrders[bi].price;
      var sellPrice = sellOrders[si].price;

      var stepCost = buyPrice * stepQty;
      var stepRev  = sellPrice * stepQty;

      // Fees
      if (buyType  === 'buy')  stepCost += stepCost * buyFee; // buy-from-buy adds brokerage
      if (sellType === 'sell') stepRev  -= stepRev  * sellFee; // sell-to-sell deducts brokerage
      stepRev -= stepRev * tax; // selling always pays tax

      var newCost = totalCost + stepCost;
      var newRev  = totalRevenue + stepRev;
      var stepMargin = newCost > 0 ? ((newRev - newCost) / newCost) * 100 : 0;

      // Only proceed if cumulative margin stays >= user minimum
      if (stepMargin < minMargin) break;

      totalCost = newCost;
      totalRevenue = newRev;
      filled += stepQty;

      buyOrders[bi].vol  -= stepQty; if (buyOrders[bi].vol  <= 0) bi++;
      sellOrders[si].vol -= stepQty; if (sellOrders[si].vol <= 0) si++;
    }

    var profit = totalRevenue - totalCost;
    var margin = totalCost > 0 ? (profit / totalCost) * 100 : 0;

    if (!isFinite(profit) || !isFinite(margin)) return null;
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
  // Uses skills + standings to compute brokerage/tax per hub
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

    $.each(marketMappings, function (hub, ids) {
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

    // kick table 3 after fees exist
    setTimeout(updateExtendedTradeTable, 0);
  }

  // ---------- extended table build ----------
  function updateExtendedTradeTable() {
    var data = window.eveMineralCompare && eveMineralCompare.extendedTradesData;
    if (!data) return;

    var buyType  = $('#buy-from-select-ext').val()  || 'buy';
    var sellType = $('#sell-to-select-ext').val()   || 'sell';
    var allowed  = getAllowedHubsExtended();
    var fees     = getBrokerageAndTaxForHub();
    var taxes    = getSalesTaxForHub();
    var qtyLimit = $('#emc-limit-60k').is(':checked') ? 6000000 : null; // 60 km^3
    var minMargin= parseFloat($('#emc-min-margin').val());
    if (!isFinite(minMargin)) minMargin = 5;

    var $tbody = $('#eve-mc-extended tbody').empty();
    var margins = [], rows = 0;

    // data is an object keyed by type_id
    $.each(data, function (id, m) {
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
      $tbody.append('<tr><td colspan="6" style="text-align:center;color:#a00;font-weight:bold">No opportunities meet the current margin threshold.</td></tr>');
    }

    var el = document.getElementById('eve-mc-extended');
    if (el) {
      el.style.setProperty('--min-margin', String(margins.length ? Math.min.apply(null, margins) : 0));
      el.style.setProperty('--max-margin', String(margins.length ? Math.max.apply(null, margins) : 0));
    }
  }

  // ---------- events ----------
  $(document).on('change', '#buy-from-select-ext, #sell-to-select-ext, #emc-limit-60k, .emc-hub-toggle', updateExtendedTradeTable);
  $(document).on('input',  '#emc-min-margin', debounce(updateExtendedTradeTable, 200));

  $(document).on('change', '.emc-skill-select', function () {
    updateEffectiveStandings();
    updateFeesDisplay();
  });
  $(document).on('input', '.emc-standing-input', debounce(function () {
    updateEffectiveStandings();
    updateFeesDisplay();
  }, 200));

  // ---------- refresh click (abort + cooldown + server cache-age message) ----------
  $(document).on('click', '#eve-mineral-refresh', function (e) {
    e.preventDefault();

    var $btn = $(this);
    if ($btn.prop('disabled')) return;

    // start cooldown immediately & persist end time
    startCooldown($btn, COOLDOWN_SEC);

    $('#eve-mineral-status').text('Working...');

    // abort any in-flight
    if (emcRefreshXhr && emcRefreshXhr.readyState !== 4) {
      emcRefreshXhr.abort();
    }

    emcRefreshXhr = $.ajax({
      url: eveMineralCompare.ajaxurl,
      method: 'POST',
      dataType: 'json',
      data: { action: 'eve_mineral_compare_refresh', nonce: eveMineralCompare.nonce },

      success: function (resp) {
        if (resp && resp.success && resp.data && resp.data.html) {
          $('#eve-mineral-compare-tables').replaceWith(resp.data.html);
          if (resp.data.extendedTradesData) {
            eveMineralCompare.extendedTradesData = resp.data.extendedTradesData;
          }
          robustInit();

          if (resp.data.refreshed) {
            if (resp.data.partial || resp.data.used_stale_backup) {
              $('#eve-mineral-status').html(
                '<strong>Partial Data Refresh</strong><br>' +
                '<em>(Some prices updated; some served from cache due to ESI issues)</em>'
              );
            } else {
              $('#eve-mineral-status').text('Prices updated!');
            }
          } else if (resp.data.busy) {
            $('#eve-mineral-status').text(resp.data.message || 'Price data refresh already in progress.');
          } else if (resp.data.used_cache) {
            var sec = Number(resp.data.cache_age_seconds);
            var ageText = 'unknown';
            if (isFinite(sec) && sec >= 0) {
              var h = Math.floor(sec / 3600);
              var m = Math.floor((sec % 3600) / 60);
              if (h > 0) {
                ageText = h + ' hour' + (h === 1 ? '' : 's') + ' ' +
                          m + ' minute' + (m === 1 ? '' : 's');
              } else {
                ageText = m + ' minute' + (m === 1 ? '' : 's');
              }
            }
            $('#eve-mineral-status').html(
              '<strong>Used Cached Prices</strong><br>' +
              '<em>(Cache is younger than 6 hours old)</em><br>' +
              'Cache age: ' + ageText
            );
          } else {
            $('#eve-mineral-status').text('No update performed.');
          }
        } else {
          $('#eve-mineral-status').text('Error refreshing data.');
        }
      },

      error: function (xhr, textStatus) {
        if (textStatus === 'abort') return; // ignore expected aborts
        $('#eve-mineral-status').text('AJAX error.');
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

  // ---------- robust init ----------
  function robustInit() {
    // defaults
    $('.emc-skill-select').each(function(){ if (!this.value) this.value = '5'; });
    $('#emc-min-margin').val($('#emc-min-margin').val() || '5');
    $('#buy-from-select-ext').val($('#buy-from-select-ext').val() || 'buy');
    $('#sell-to-select-ext').val($('#sell-to-select-ext').val() || 'sell');

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
        emcSyncRefreshButton(); // re-apply cooldown after DOM swap
      } else if (tries >= maxTries) {
        clearInterval(t);
        updateFeesDisplay();
        setTimeout(updateExtendedTradeTable, 20);
        emcSyncRefreshButton();
      }
    }, 120);
  }

  // first mount
  robustInit();
});
