<?php
/*
Plugin Name: EVE Mineral Compare
Description: Shows best buy/sell prices for EVE minerals at major trade hubs, with AJAX refresh and caching. Adds extended trade simulation table.
Version: 2.0
Author: Your Name
*/

define('EVE_MINERAL_COMPARE_VERSION', '2.0');
define('EVE_MINERAL_COMPARE_CACHE_AGE', 6 * 3600);
define('EVE_MINERAL_COMPARE_MAX_ORDERS_PER_SIDE', 150);
define('EVE_MINERAL_COMPARE_MAX_PAGES', 5);

/** Atomic write helper (temp file + rename) */
function emc_atomic_write($path, $data) {
    $tmp = $path . '.' . uniqid('tmp', true);
    $bytes = @file_put_contents($tmp, $data, LOCK_EX);
    if ($bytes === false) return false;
    return @rename($tmp, $path);
}

function eve_mineral_compare_get_minerals() {
    return [
        34 => 'Tritanium', 35 => 'Pyerite', 36 => 'Mexallon', 37 => 'Isogen',
        38 => 'Nocxium', 39 => 'Zydrine', 40 => 'Megacyte', 11399 => 'Morphite'
    ];
}

function eve_mineral_compare_get_hubs() {
    return [
        ['region_id'=>10000002, 'name'=>'Jita',    'systems'=>[30000142, 30000144]],
        ['region_id'=>10000043, 'name'=>'Amarr',   'systems'=>[30002187, 30003491]],
        ['region_id'=>10000030, 'name'=>'Rens',    'systems'=>[30002510, 30002526]],
        ['region_id'=>10000042, 'name'=>'Hek',     'systems'=>[30002053, 30002068]],
        ['region_id'=>10000032, 'name'=>'Dodixie', 'systems'=>[30002659, 30002661]]
    ];
}

function eve_mineral_compare_cache_dir() {
    $upload_dir = wp_upload_dir();
    $dir = trailingslashit($upload_dir['basedir']) . 'eve-mineral-compare/cache/';
    if (!is_dir($dir)) wp_mkdir_p($dir);

    // Harden directory: block listing and direct JSON access
    if (!file_exists($dir . 'index.html')) {
        @file_put_contents($dir . 'index.html', '', LOCK_EX);
    }
    $ht = $dir . '.htaccess';
    if (!file_exists($ht)) {
        @file_put_contents($ht, "Options -Indexes\n<Files *.json>\nRequire all denied\n</Files>\n", LOCK_EX);
    }
    return $dir;
}

function eve_mineral_compare_cache_prefix() {
    return eve_mineral_compare_cache_dir() . 'market_cache';
}

function eve_mineral_compare_system_map_file() {
    return eve_mineral_compare_cache_dir() . 'system_map.json';
}

/** HTTP GET with small retry/backoff */
function eve_mc_http_get($url, $timeout=20, $retries=2) {
    $args = [
        'timeout' => $timeout,
        'headers' => ['User-Agent' => 'EVE Mineral Compare v' . EVE_MINERAL_COMPARE_VERSION]
    ];
    $delay = 0.3;
    for ($i=0; $i <= $retries; $i++) {
        $resp = wp_remote_get($url, $args);
        if (!is_wp_error($resp) && wp_remote_retrieve_response_code($resp) === 200) {
            return $resp;
        }
        usleep((int)($delay * 1e6));
        $delay *= 2;
    }
    return $resp; // return last response (could be WP_Error)
}

/** Load only fresh chunks (<=6h) */
function eve_mineral_compare_load_cache_chunks() {
    $merged = [];
    for ($i=1; $i<=99; $i++) {
        $file = eve_mineral_compare_cache_prefix()."_{$i}.json";
        if (!is_file($file)) break;
        if (time() - filemtime($file) > EVE_MINERAL_COMPARE_CACHE_AGE) continue;
        $data = json_decode(@file_get_contents($file), true);
        if (!is_array($data)) continue;
        foreach ($data as $tid => $record) {
            if (!isset($record['name'])) continue;
            $merged[$tid] = $record;
        }
    }
    return $merged;
}

/** Load chunks regardless of freshness (for stale fallback) */
function eve_mineral_compare_load_all_cache_chunks() {
    $merged = [];
    for ($i=1; $i<=99; $i++) {
        $file = eve_mineral_compare_cache_prefix()."_{$i}.json";
        if (!is_file($file)) break;
        $data = json_decode(@file_get_contents($file), true);
        if (!is_array($data)) continue;
        foreach ($data as $tid => $record) {
            if (!isset($record['name'])) continue;
            $merged[$tid] = $record;
        }
    }
    return $merged;
}

function eve_mineral_compare_save_cache_chunks(array $data) {
    // clear old files
    for ($i=1; $i<=99; $i++) {
        $f = eve_mineral_compare_cache_prefix()."_{$i}.json";
        if (file_exists($f)) @unlink($f);
    }
    $chunks = array_chunk(array_keys($data), 8);
    foreach ($chunks as $i => $set) {
        $out = [];
        foreach ($set as $tid) $out[$tid] = $data[$tid];
        $path = eve_mineral_compare_cache_prefix().'_'.($i+1).'.json';
        if (!emc_atomic_write($path, json_encode($out, JSON_PARTIAL_OUTPUT_ON_ERROR))) {
            error_log('EVE Mineral Compare: failed to write cache chunk ' . ($i+1));
        }
    }
}

function eve_mineral_compare_resolve_system_id($loc_id, &$map, $primary, $secondary, $scope) {
    if (isset($map[$loc_id])) return $map[$loc_id];
    if ($loc_id >= 1000000000000) { // citadel heuristic
        $map[$loc_id] = ($scope === 'secondary') ? $secondary : $primary;
        return $map[$loc_id];
    }
    $resp = eve_mc_http_get("https://esi.evetech.net/latest/universe/stations/{$loc_id}/");
    if (is_wp_error($resp)) { $map[$loc_id] = null; return null; }
    $body = json_decode(wp_remote_retrieve_body($resp), true);
    $map[$loc_id] = $body['system_id'] ?? null;
    return $map[$loc_id];
}

/** Freshness helper */
function eve_mineral_compare_cache_is_fresh() {
    $f = eve_mineral_compare_cache_prefix()."_1.json";
    return file_exists($f) && (time() - filemtime($f) <= EVE_MINERAL_COMPARE_CACHE_AGE);
}

/**
 * Update cache. If ESI is flaky, fallback to stale cache per entry (partial refresh).
 * @return array Final dataset
 */
function eve_mineral_compare_update_cache($force=false, &$refreshed=null, &$partial=false, &$used_stale_backup=false) {
    $minerals = eve_mineral_compare_get_minerals();
    $hubs     = eve_mineral_compare_get_hubs();
    $map_file = eve_mineral_compare_system_map_file();
    $map      = is_file($map_file) ? json_decode(@file_get_contents($map_file), true) : [];
    if (!is_array($map)) $map = [];

    $need_refresh = $force || !eve_mineral_compare_cache_is_fresh();
    if (!$need_refresh) { $refreshed=false; $partial=false; $used_stale_backup=false; return eve_mineral_compare_load_cache_chunks(); }

    $refreshed = true; $partial=false; $used_stale_backup=false;
    $old_cache = eve_mineral_compare_load_all_cache_chunks();

    $final = [];
    foreach ($minerals as $tid => $name) $final[$tid] = ['name' => $name];

    foreach ($hubs as $hub) {
        $region    = $hub['region_id'];
        $hub_name  = $hub['name'];
        $primary   = $hub['systems'][0];
        $secondary = $hub['systems'][1] ?? null;

        foreach ($minerals as $tid => $mname) {
            $buys=[]; $sells=[]; $page=1; $pages=1;

            do {
                $resp = eve_mc_http_get("https://esi.evetech.net/latest/markets/{$region}/orders/?order_type=all&type_id={$tid}&page={$page}");
                if (is_wp_error($resp)) break;
                $arr = json_decode(wp_remote_retrieve_body($resp), true);
                if (!is_array($arr)) break;

                foreach ($arr as $o) {
                    if (!isset($o['location_id'], $o['price'], $o['volume_remain'], $o['is_buy_order'])) continue;
                    $sys = eve_mineral_compare_resolve_system_id($o['location_id'], $map, $primary, $secondary, $secondary ? 'secondary' : 'primary');
                    if (!$sys || !in_array($sys, $hub['systems'], true)) continue;

                    $price = (float)$o['price'];
                    $vol   = (int)$o['volume_remain'];
                    if (!is_finite($price) || $price <= 0 || $price > 1e10) continue;
                    if ($vol <= 0 || $vol > 1e12) continue;

                    if (!empty($o['is_buy_order'])) {
                        $buys[]  = ['price'=>$price, 'vol'=>$vol];
                    } else {
                        $sells[] = ['price'=>$price, 'vol'=>$vol];
                    }
                }

                $pages = intval(wp_remote_retrieve_header($resp,'x-pages')) ?: 1;
                $page++;
            } while ($page <= min($pages, EVE_MINERAL_COMPARE_MAX_PAGES));

            // Sort best-first
            usort($buys,  fn($a,$b)=> $b['price'] <=> $a['price']);
            usort($sells, fn($a,$b)=> $a['price'] <=> $b['price']);

            // Trim to max per side
            $buys  = array_slice($buys,  0, EVE_MINERAL_COMPARE_MAX_ORDERS_PER_SIDE);
            $sells = array_slice($sells, 0, EVE_MINERAL_COMPARE_MAX_ORDERS_PER_SIDE);

            // Top-of-book sums at best price
            $bbp = $bsp = null; $bbv = $bsv = 0;
            if ($buys)  { $bbp = $buys[0]['price'];  foreach ($buys  as $o) if ($o['price'] == $bbp) $bbv += $o['vol']; }
            if ($sells) { $bsp = $sells[0]['price']; foreach ($sells as $o) if ($o['price'] == $bsp) $bsv += $o['vol']; }

            // Fallback to stale if both missing
            if (($bbp === null && $bsp === null) && isset($old_cache[$tid][$hub_name])) {
                $fallback = $old_cache[$tid][$hub_name];
                $bbp = is_numeric($fallback['buy']  ?? null) ? (float)$fallback['buy']  : null;
                $bsp = is_numeric($fallback['sell'] ?? null) ? (float)$fallback['sell'] : null;
                $buys  = $fallback['buy_orders']  ?? [];
                $sells = $fallback['sell_orders'] ?? [];
                $bbv = is_numeric($fallback['buy_volume']  ?? null) ? (int)$fallback['buy_volume']  : 0;
                $bsv = is_numeric($fallback['sell_volume'] ?? null) ? (int)$fallback['sell_volume'] : 0;
                if ($bbp !== null || $bsp !== null) { $partial = true; $used_stale_backup = true; }
            }

            $final[$tid][$hub_name] = [
                'buy'         => $bbp ?? 'N/A',
                'sell'        => $bsp ?? 'N/A',
                'buy_volume'  => $bbp ? $bbv : null,
                'sell_volume' => $bsp ? $bsv : null,
                'buy_orders'  => $buys,
                'sell_orders' => $sells
            ];
        }
    }

    // Persist system map + chunks (atomic)
    emc_atomic_write($map_file, json_encode($map, JSON_PARTIAL_OUTPUT_ON_ERROR));
    eve_mineral_compare_save_cache_chunks($final);

    return $final;
}

function eve_mineral_compare_build_table_rows($minerals, $hubs, $data, $type) {
    $rows = [];
    foreach ($minerals as $tid => $name) {
        $vals = [];
        foreach ($hubs as $hub) {
            $hubName = $hub['name'];
            $val = null;
            if (isset($data[$tid][$hubName][$type]) && is_numeric($data[$tid][$hubName][$type])) {
                $val = (float)$data[$tid][$hubName][$type];
            }
            $vals[] = $val;
        }

        $ranked = $vals; arsort($ranked);
        $top3 = array_slice(array_keys($ranked), 0, 3);

        $cells = [];
        foreach ($vals as $idx => $val) {
            $disp = $val === null ? 'N/A' : number_format($val, 2);
            $class = '';
            if (in_array($idx, $top3, true)) {
                $rank = array_search($idx, $top3, true);
                if ($rank === 0) $class = 'emc-rank-1';
                elseif ($rank === 1) $class = 'emc-rank-2';
                elseif ($rank === 2) $class = 'emc-rank-3';
            }
            $cells[] = ['value' => $disp, 'class' => $class];
        }
        $rows[] = ['mineral' => $name, 'cells' => $cells];
    }
    return $rows;
}

/** Build localized data strictly from fresh cache (no network). */
function eve_mineral_compare_prepare_best_trade_data() {
    $minerals = eve_mineral_compare_get_minerals();
    $hubs = eve_mineral_compare_get_hubs();
    $data = eve_mineral_compare_load_cache_chunks(); // fresh only

    $out = [];
    foreach ($minerals as $tid => $name) {
        $out[$tid] = ['name' => $name, 'hubs' => []];
        foreach ($hubs as $hub) {
            $hn = $hub['name'];
            $e = $data[$tid][$hn] ?? [];
            $out[$tid]['hubs'][$hn] = [
                'buy'         => is_numeric($e['buy']  ?? null) ? (float)$e['buy']  : 'N/A',
                'sell'        => is_numeric($e['sell'] ?? null) ? (float)$e['sell'] : 'N/A',
                'buy_volume'  => $e['buy_volume']  ?? null,
                'sell_volume' => $e['sell_volume'] ?? null,
                'buy_orders'  => $e['buy_orders']  ?? [],
                'sell_orders' => $e['sell_orders'] ?? []
            ];
        }
    }
    return $out;
}

function eve_mineral_compare_render_tables() {
    $minerals = eve_mineral_compare_get_minerals();
    $hubs     = eve_mineral_compare_get_hubs();
    $cache    = eve_mineral_compare_load_cache_chunks();
    $buy_rows  = eve_mineral_compare_build_table_rows($minerals, $hubs, $cache, 'buy');
    $sell_rows = eve_mineral_compare_build_table_rows($minerals, $hubs, $cache, 'sell');

    ob_start();
    include __DIR__ . '/template.php';
    return ob_get_clean();
}

add_action('wp_enqueue_scripts', function() {
    if (is_admin()) return;

    wp_enqueue_style(
        'eve-mineral-compare-style',
        plugins_url('style.css', __FILE__),
        [],
        EVE_MINERAL_COMPARE_VERSION
    );

    wp_enqueue_script(
        'eve-mineral-compare-js',
        plugins_url('script.js', __FILE__),
        ['jquery'],
        EVE_MINERAL_COMPARE_VERSION,
        true
    );

    // Localize strictly from cache (no fetch)
    wp_localize_script('eve-mineral-compare-js', 'eveMineralCompare', [
        'ajaxurl' => admin_url('admin-ajax.php'),
        'nonce'   => wp_create_nonce('eve_mineral_compare_refresh'),
        'extendedTradesData' => eve_mineral_compare_prepare_best_trade_data(),
    ]);
});

add_shortcode('eve_mineral_compare', function() {
    // Render from cache only
    return eve_mineral_compare_render_tables();
});

add_action('wp_ajax_eve_mineral_compare_refresh','eve_mineral_compare_refresh_callback');
add_action('wp_ajax_nopriv_eve_mineral_compare_refresh','eve_mineral_compare_refresh_callback');

function eve_mineral_compare_refresh_callback() {
    // AJAX headers that discourage indexing
    header('X-Robots-Tag: noindex, nofollow', true);

    check_ajax_referer('eve_mineral_compare_refresh','nonce');

    // Per-IP throttle
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $transient_key = 'emc_refresh_lock_' . md5($ip);
    if (get_transient($transient_key)) {
        wp_send_json_error(['message' => 'Please wait before refreshing again.'], 429);
    }
    set_transient($transient_key, true, 20);

    // Global lock to prevent stampede
    $global_lock = 'emc_refresh_lock_global';
    $busy = false;

    $used_cache = false;
    $refreshed  = false;
    $partial    = false;
    $used_stale_backup = false;

    if (get_transient($global_lock)) {
        // Another request is refreshing right now; reuse current cache
        $busy = true;
        $used_cache = true;
    } else {
        if (eve_mineral_compare_cache_is_fresh()) {
            $used_cache = true;
        } else {
            set_transient($global_lock, true, 90); // keep short; just enough to avoid dogpile
            eve_mineral_compare_update_cache(true, $refreshed, $partial, $used_stale_backup);
            delete_transient($global_lock);
        }
    }

    $full_html = eve_mineral_compare_render_tables();

    $first_chunk = eve_mineral_compare_cache_prefix()."_1.json";
    $cache_age_seconds = (file_exists($first_chunk)) ? max(0, time() - filemtime($first_chunk)) : null;

    wp_send_json_success([
        'html' => $full_html,
        'extendedTradesData' => eve_mineral_compare_prepare_best_trade_data(),
        'refreshed'  => $refreshed,
        'used_cache' => $used_cache,
        'busy'       => $busy,
        'partial'    => $partial,
        'used_stale_backup' => $used_stale_backup,
        'cache_age_seconds' => $cache_age_seconds,
    ]);
}
