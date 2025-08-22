<?php
// Anonymous throttle token (set early, before output)
add_action('init', function(){
    if (is_user_logged_in()) { return; }
    $cookie_name = 'emc_tid';
    if (empty($_COOKIE[$cookie_name])) {
        try {
            $rand = function_exists('random_bytes') ? bin2hex(random_bytes(16)) : '';
            if (empty($rand) && function_exists('openssl_random_pseudo_bytes')) {
                $rand = bin2hex(openssl_random_pseudo_bytes(16));
            }
            if (empty($rand)) {
                $rand = md5(uniqid('', true) . microtime(true));
            }
        } catch (\Throwable $e) {
            $rand = md5(uniqid('', true) . microtime(true));
        }
        $cookie_path   = defined('COOKIEPATH') ? COOKIEPATH : '/';
        $cookie_domain = defined('COOKIE_DOMAIN') ? COOKIE_DOMAIN : '';
        $secure        = function_exists('is_ssl') ? is_ssl() : (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
        @setcookie($cookie_name, $rand, time()+86400, $cookie_path, $cookie_domain, $secure, true);
        $_COOKIE[$cookie_name] = $rand;
    }
}, 1);


/*
Plugin Name: EVE Mineral Compare
Description: Shows best buy/sell prices for EVE minerals at major trade hubs, with REST refresh and caching. Adds extended trade simulation table.
Version: 4.1.3
Author: C4813
*/

define('EVE_MINERAL_COMPARE_VERSION', '4.1.3');
define('EVE_MINERAL_COMPARE_CACHE_AGE', 6 * 3600);
define('EVE_MINERAL_COMPARE_MAX_ORDERS_PER_SIDE', 150);
define('EVE_MINERAL_COMPARE_MAX_PAGES', 5);
define('EVE_MINERAL_COMPARE_EPS', 0.0001);

/** Atomic write helper (temp file + rename) */
function emc_atomic_write($path, $data) {
    $tmp = $path . '.' . uniqid('tmp', true);
    $bytes = @file_put_contents($tmp, $data, LOCK_EX);
    if ($bytes === false) return false;
    return @rename($tmp, $path);
}

function emc_on_activate() {
    $dir = eve_mineral_compare_cache_dir();
    if (!is_dir($dir) || !is_writable($dir)) {
        error_log('EVE Mineral Compare: cache directory not writable on activation: ' . $dir);
    }
}
register_activation_hook(__FILE__, 'emc_on_activate');

/** Uninstall cleanup handled in main file */
function emc_rrmdir($path) {
    if (!is_dir($path)) return;
    $items = @scandir($path);
    if (!$items) return;
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') continue;
        $full = $path . $item;
        if (is_dir($full)) {
            emc_rrmdir($full . '/');
            @rmdir($full);
        } else {
            @unlink($full);
        }
    }
    @rmdir($path);
}

function emc_on_uninstall() {
    // Remove cached files/folders under uploads/eve-mineral-compare/
    $upload_dir = wp_upload_dir();
    $base = isset($upload_dir['basedir']) ? $upload_dir['basedir'] : WP_CONTENT_DIR.'/uploads';
    $root = trailingslashit($base) . 'eve-mineral-compare/';

    emc_rrmdir($root);

    // Delete plugin transients
    global $wpdb;
    $wpdb->query("DELETE FROM {$wpdb->options} WHERE option_name LIKE '_transient_emc_refresh_lock_%' OR option_name='_transient_emc_refresh_lock_global'");
}
register_uninstall_hook(__FILE__, 'emc_on_uninstall');

function emc_atomic_write_json($path, $arr) {
    $json = wp_json_encode($arr, JSON_PARTIAL_OUTPUT_ON_ERROR);
    if (!is_string($json)) return false;
    $len = strlen($json);
    if ($len === 0 || $len > 5 * 1024 * 1024) { // 5MB cap
        error_log('EVE Mineral Compare: refusing to write JSON (size '.$len.') to ' . $path);
        return false;
    }
    return emc_atomic_write($path, $json);
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
    $basedir = isset($upload_dir['basedir']) ? $upload_dir['basedir'] : '';
    if (empty($basedir)) {
        error_log('EVE Mineral Compare: uploads base dir unavailable');
        $basedir = WP_CONTENT_DIR . '/uploads'; // last resort
    }
    $dir = trailingslashit($basedir) . 'eve-mineral-compare/cache/';
    if (!is_dir($dir)) wp_mkdir_p($dir);

    // Harden directory: block listing and direct JSON access
    if (!file_exists($dir . 'index.html')) {
        @file_put_contents($dir . 'index.html', '', LOCK_EX);
    }
    // Server detection
    $server    = $_SERVER['SERVER_SOFTWARE'] ?? '';
    $is_apache = stripos($server, 'Apache') !== false;
    $is_iis    = function_exists('iis7_supports_permalinks') && iis7_supports_permalinks();

    // Apache .htaccess
    if ($is_apache) {
        $ht = $dir . '.htaccess';
        if (!file_exists($ht)) {
            @file_put_contents($ht, "Options -Indexes\n<Files *.json>\nRequire all denied\n</Files>\n", LOCK_EX);
        }
    }
    // IIS web.config
    if ($is_iis) {
        $webconfig = $dir . 'web.config';
        if (!file_exists($webconfig)) {
            @file_put_contents($webconfig, '<?xml version="1.0"?>
<configuration><system.webServer>
  <security>
    <authorization>
      <deny users="*" />
    </authorization>
  </security>
</system.webServer></configuration>', LOCK_EX);
        }
    }
    // Explain cache folder
    $readme = $dir . 'README.txt';
    if (!file_exists($readme)) {
        @file_put_contents($readme,
            "EVE Mineral Compare cache folder.\n".
            "Safe to delete; files will be recreated.\n".
            "Apache: .htaccess blocks *.json here.\n".
            "Nginx: deny *.json here with a location block.\n".
            "IIS: web.config blocks *.json here.\n", LOCK_EX);
    }

    return $dir;
}

function eve_mineral_compare_cache_prefix() {
    return eve_mineral_compare_cache_dir() . 'market_cache';
}

function eve_mineral_compare_system_map_file() {
    return eve_mineral_compare_cache_dir() . 'system_map.json';
}

/** Page cache + ETag helpers (for ESI market pages) */
function eve_mineral_compare_page_cache_dir() {
    $dir = trailingslashit(eve_mineral_compare_cache_dir()) . 'pages/';
    if (!is_dir($dir)) wp_mkdir_p($dir);
    return $dir;
}
function eve_mineral_compare_etag_file() {
    return trailingslashit(eve_mineral_compare_cache_dir()) . 'etags.json';
}
function eve_mineral_compare_load_etags() {
    $f = eve_mineral_compare_etag_file();
    $m = is_file($f) ? json_decode(@file_get_contents($f), true) : [];
    return is_array($m) ? $m : [];
}
function eve_mineral_compare_save_etags(array $m) {
    emc_atomic_write_json(eve_mineral_compare_etag_file(), $m);
}
function eve_mineral_compare_page_key($region, $tid, $page) {
    return "{$region}_{$tid}_{$page}";
}
function eve_mineral_compare_page_path($region, $tid, $page) {
    return eve_mineral_compare_page_cache_dir() . 'orders_' . eve_mineral_compare_page_key($region, $tid, $page) . '.json';
}

/**
 * HTTP GET with retry/backoff + jitter.
 * Also reads ESI error-limit headers to gently back off when close to limits.
 */
function eve_mc_http_get($url, $timeout=20, $retries=2) {
    $parts = wp_parse_url($url);
    if (!$parts || !isset($parts['host']) || strtolower($parts['host']) !== 'esi.evetech.net' || ($parts['scheme'] ?? '') !== 'https') {
        return new WP_Error('emc_bad_url', 'Blocked unexpected URL');
    }
    $args = [
        'timeout'      => $timeout,
        'redirection'  => 1,
        'reject_unsafe_urls' => true,
        'headers' => ['User-Agent' => 'EVE Mineral Compare v' . EVE_MINERAL_COMPARE_VERSION]
    ];
    $delay = 0.3;
    $resp  = null;
    for ($i=0; $i <= $retries; $i++) {
        $resp = wp_safe_remote_get($url, $args);
        if (!is_wp_error($resp)) {
            $code = wp_remote_retrieve_response_code($resp);
            if ($code === 200) return $resp;

            // Back off harder on ESI limits/outages
            if (in_array($code, [420,429,503], true)) {
                $reset = (int) wp_remote_retrieve_header($resp, 'x-esi-error-limit-reset');
                if ($reset > 0) {
                    usleep(min(3000000, $reset * 500000)); // up to 3s
                }
            }

            // Gentle, generic backoff if ESI error limit is low
            $remain = (int) wp_remote_retrieve_header($resp, 'x-esi-error-limit-remain');
            $reset  = (int) wp_remote_retrieve_header($resp, 'x-esi-error-limit-reset');
            if ($remain !== 0 && $remain <= 2 && $reset > 0) {
                usleep(min(1500000, $reset * 300000)); // ~0.3s per sec left, capped
            }
        }
        // add jitter
        $jitter = mt_rand(0, 100) / 1000.0; // 0–0.1s
        usleep((int)(($delay + $jitter) * 1e6));
        $delay *= 2;
    }
    return $resp; // return last response (could be WP_Error)
}

/** ================== ESI HISTORY + TREND HELPERS ================== */

/**
 * Fetch region/type daily history (cached) from ESI.
 * Returns array of day rows (oldest->newest as per ESI).
 */
function eve_mc_fetch_market_history($region_id, $type_id) {
    $ckey = "emc_hist_{$region_id}_{$type_id}";
    $cached = get_transient($ckey);
    if ($cached && is_array($cached)) return $cached;

    $url = "https://esi.evetech.net/latest/markets/{$region_id}/history/?datasource=tranquility&type_id={$type_id}";
    $resp = eve_mc_http_get($url);
    if (is_wp_error($resp)) return [];

    $code = wp_remote_retrieve_response_code($resp);
    if ($code !== 200) return [];

    $body = wp_remote_retrieve_body($resp);
    $data = json_decode($body, true);
    if (!is_array($data)) $data = [];

    // Cache alongside other caches
    set_transient($ckey, $data, EVE_MINERAL_COMPARE_CACHE_AGE);
    return $data;
}

function emc_array_tail($arr, $n) {
    if (!is_array($arr) || $n <= 0) return [];
    $len = count($arr);
    if ($len <= $n) return $arr;
    return array_slice($arr, $len - $n, $n);
}

/**
 * Compute trend for a given history field.
 * Uses last 8 entries: compares today's field vs average of previous 7.
 */
function eve_mc_compute_trend(array $hist, $field) {
    // Need 31 rows: today + previous 30
    $last31 = emc_array_tail($hist, 31);
    if (count($last31) < 31) {
        return ['today' => null, 'avg30' => null, 'pct' => null, 'dir' => 'flat'];
    }

    // Today's row is the newest
    $todayRow = $last31[30];
    $prev30   = array_slice($last31, 0, 30);

    // If today's field is missing, we can't compute a trend
    if (!isset($todayRow[$field]) || !is_numeric($todayRow[$field])) {
        return ['today' => null, 'avg30' => null, 'pct' => null, 'dir' => 'flat'];
    }

    $today = (float) $todayRow[$field];

    // Average of the previous 30 values
    $sum = 0.0;
    $cnt = 0;
    foreach ($prev30 as $r) {
        if (isset($r[$field]) && is_numeric($r[$field])) {
            $sum += (float) $r[$field];
            $cnt++;
        }
    }

    if ($cnt === 0) {
        return ['today' => $today, 'avg30' => null, 'pct' => null, 'dir' => 'flat'];
    }

    $avg30 = $sum / $cnt;

    // Avoid division-by-zero (or near-zero) issues
    if ($avg30 == 0.0) {
        return ['today' => $today, 'avg30' => $avg30, 'pct' => null, 'dir' => 'flat'];
    }

    $pct = (($today - $avg30) / $avg30) * 100.0;
    $dir = ($pct > 0) ? 'up' : (($pct < 0) ? 'down' : 'flat');

    return ['today' => $today, 'avg30' => $avg30, 'pct' => $pct, 'dir' => $dir];
}

function eve_mc_compute_sell_trend(array $hist) { // highest for Sell
    return eve_mc_compute_trend($hist, 'highest');
}
function eve_mc_compute_buy_trend(array $hist) {  // lowest  for Buy
    return eve_mc_compute_trend($hist, 'lowest');
}

/** ================================================================ */



/** Strict host/scheme HTTP with custom headers (ETag etc.) */
function emc_http_get_with_headers($url, array $headers = [], $timeout = 20, $retries = 2) {
    $parts = wp_parse_url($url);
    if (!$parts || !isset($parts['host']) || strtolower($parts['host']) !== 'esi.evetech.net' || ($parts['scheme'] ?? '') !== 'https') {
        return new WP_Error('emc_bad_url', 'Blocked unexpected URL');
    }
    $args = [
        'timeout'      => $timeout,
        'redirection'  => 1,
        'reject_unsafe_urls' => true,
        'headers'      => array_merge(['User-Agent' => 'EVE Mineral Compare v' . EVE_MINERAL_COMPARE_VERSION], $headers),
    ];
    $delay = 0.3;
    $resp  = null;
    for ($i=0; $i <= $retries; $i++) {
        $resp = wp_safe_remote_get($url, $args);
        if (!is_wp_error($resp)) {
            $code = wp_remote_retrieve_response_code($resp);
            if ($code === 200 || $code === 304) return $resp;

            if (in_array($code, [420,429,503], true)) {
                $reset = (int) wp_remote_retrieve_header($resp, 'x-esi-error-limit-reset');
                if ($reset > 0) usleep(min(3000000, $reset * 500000));
            }
            $remain = (int) wp_remote_retrieve_header($resp, 'x-esi-error-limit-remain');
            $reset  = (int) wp_remote_retrieve_header($resp, 'x-esi-error-limit-reset');
            if ($remain !== 0 && $remain <= 2 && $reset > 0) usleep(min(1500000, $reset * 300000));
        }
        $jitter = mt_rand(0, 100) / 1000.0;
        usleep((int)(($delay + $jitter) * 1e6));
        $delay *= 2;
    }
    return $resp;
}

/**
 * Fetch a market page with If-None-Match and local page cache.
 * Returns array|null (decoded JSON) and updates $etagMap by reference.
 * Captures X-Pages to inform outer loops.
 */
function eve_mineral_compare_fetch_market_page($region, $tid, $page, array &$etagMap) {
    $key  = eve_mineral_compare_page_key($region, $tid, $page);
    $path = eve_mineral_compare_page_path($region, $tid, $page);
    $etag = $etagMap[$key] ?? null;

    $url = "https://esi.evetech.net/latest/markets/{$region}/orders/?datasource=tranquility&order_type=all&type_id={$tid}&page={$page}";
    $args = [
        'timeout' => 20,
        'redirection' => 1,
        'reject_unsafe_urls' => true,
        'headers' => ['User-Agent' => 'EVE Mineral Compare v' . EVE_MINERAL_COMPARE_VERSION],
    ];
    if ($etag) $args['headers']['If-None-Match'] = $etag;

    $resp = emc_http_get_with_headers($url, $args['headers'] ?? [], 20, 2);
    if (is_wp_error($resp)) return null;

    // Gentle rate-limit backoff near edge
    $remain = (int) wp_remote_retrieve_header($resp, 'x-esi-error-limit-remain');
    $reset  = (int) wp_remote_retrieve_header($resp, 'x-esi-error-limit-reset');
    if ($remain !== 0 && $remain <= 2 && $reset > 0) {
        usleep(min(1500000, $reset * 300000)); // ~0.3s per sec left, capped
    }

    // Capture pages hint
    $pagesHdr = (int) wp_remote_retrieve_header($resp, 'x-pages');
    if ($pagesHdr > 0) {
        $etagMap['__pages__'.eve_mineral_compare_page_key($region,$tid,0)] = min($pagesHdr, EVE_MINERAL_COMPARE_MAX_PAGES);
    }

    $code = wp_remote_retrieve_response_code($resp);

    if ($code === 304) {
        if (file_exists($path)) {
            $json = json_decode(@file_get_contents($path), true);
            return is_array($json) ? $json : null;
        }
        // 304 but we don't have a cached body → one-time unconditional refetch
        unset($args['headers']['If-None-Match']);
        $resp = emc_http_get_with_headers($url, $args['headers'] ?? [], 20, 2);
        if (is_wp_error($resp)) return null;
        $code = wp_remote_retrieve_response_code($resp);
    }

    if ($code === 200) {
        $body = wp_remote_retrieve_body($resp);
        if (!is_string($body) || strlen($body) > 8 * 1024 * 1024) { // 8MB cap
            return null;
        }
        $json = json_decode($body, true);
        if (is_array($json)) {
            $newEtag = wp_remote_retrieve_header($resp, 'etag');
            if ($newEtag) $etagMap[$key] = $newEtag;
            emc_atomic_write($path, $body);
            return $json;
        }
    }

    return null;
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

/** Try fresh cache first; fall back to stale chunks if fresh is empty. */
function eve_mineral_compare_load_cache_fresh_or_stale(&$used_stale = false) {
    $used_stale = false;
    $fresh = eve_mineral_compare_load_cache_chunks();
    if (!empty($fresh)) return $fresh;
    $used_stale = true;
    return eve_mineral_compare_load_all_cache_chunks();
}

function eve_mineral_compare_save_cache_chunks(array $data) {
    // Ensure cache dir guard exists (Nginx-safe). No-op if already there.
    $cacheDir = eve_mineral_compare_cache_dir();
    $indexPhp = $cacheDir . 'index.php';
    if (!file_exists($indexPhp)) {
        @file_put_contents($indexPhp, "<?php http_response_code(404); exit;", LOCK_EX);
    }

    // Two-phase write: write to tmp prefix, then swap.
    $prefix    = eve_mineral_compare_cache_prefix();
    $tmpPrefix = $prefix . '_new';

    // Clean stale tmp
    for ($i=1; $i<=99; $i++) {
        $f = "{$tmpPrefix}_{$i}.json";
        if (file_exists($f)) @unlink($f);
    }

    // Write new chunks to tmp
    $keys   = array_keys($data);
    $chunks = array_chunk($keys, 8);
    foreach ($chunks as $i => $set) {
        $out = [];
        foreach ($set as $tid) $out[$tid] = $data[$tid];
        $path = "{$tmpPrefix}_".($i+1).'.json';
        if (!emc_atomic_write($path, wp_json_encode($out, JSON_PARTIAL_OUTPUT_ON_ERROR))) {
            error_log('EVE Mineral Compare: failed to write tmp cache chunk ' . ($i+1));
            return false; // abort swap; keep old cache
        }
    }

    // Verify all tmp chunks exist before swap
    for ($i=1; $i<=count($chunks); $i++) {
        if (!file_exists("{$tmpPrefix}_{$i}.json")) {
            error_log('EVE Mineral Compare: missing tmp chunk during swap');
            return false;
        }
    }

    // Swap under a filesystem lock to avoid races
    $lockPath = $cacheDir.'swap.lock';
    $lock = @fopen($lockPath, 'c');
    if ($lock) @flock($lock, LOCK_EX);

    // Remove old live files, then rename tmp → live
    for ($i=1; $i<=99; $i++) {
        $old = "{$prefix}_{$i}.json";
        if (file_exists($old)) @unlink($old);
    }
    for ($i=1; $i<=count($chunks); $i++) {
        $ok = @rename("{$tmpPrefix}_{$i}.json", "{$prefix}_{$i}.json");
        if (!$ok) {
            error_log('EVE Mineral Compare: failed to swap chunk '.$i);
            for ($j=1; $j<$i; $j++) { @unlink("{$prefix}_{$j}.json"); }
            if ($lock) { @flock($lock, LOCK_UN); @fclose($lock); }
            return false;
        }
    }

    if ($lock) { @flock($lock, LOCK_UN); @fclose($lock); }
    return true;
}

function eve_mineral_compare_resolve_system_id($loc_id, &$map, $primary, $secondary, $scope) {
    if (isset($map[$loc_id])) return $map[$loc_id];
    if ($loc_id >= 1000000000000) { // citadel heuristic (kept as-is)
        $map[$loc_id] = ($scope === 'secondary') ? $secondary : $primary;
        return $map[$loc_id];
    }
    $resp = eve_mc_http_get("https://esi.evetech.net/latest/universe/stations/{$loc_id}/?datasource=tranquility");
    if (is_wp_error($resp)) { $map[$loc_id] = null; return null; }
    $raw = wp_remote_retrieve_body($resp);
    if (!is_string($raw) || strlen($raw) > 512 * 1024) { // 512KB cap (station payloads are tiny)
        $map[$loc_id] = null; 
        return null;
    }
    $body = json_decode($raw, true);
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
 * Uses ETag-based page cache for market pages.
 * @return array Final dataset
 */
function eve_mineral_compare_update_cache($force=false, &$refreshed=null, &$partial=false, &$used_stale_backup=false, &$cache_write_ok=true) {
    $minerals = eve_mineral_compare_get_minerals();
    $hubs     = eve_mineral_compare_get_hubs();
    $map_file = eve_mineral_compare_system_map_file();
    $map      = is_file($map_file) ? json_decode(@file_get_contents($map_file), true) : [];
    if (!is_array($map)) $map = [];

    $etagMap  = eve_mineral_compare_load_etags();

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
            $buys=[]; $sells=[]; $page=1;
            $maxPages = EVE_MINERAL_COMPARE_MAX_PAGES;

            do {
                $arr = eve_mineral_compare_fetch_market_page($region, $tid, $page, $etagMap);

                // after first call we might have learned real pages:
                $hint = $etagMap['__pages__'.eve_mineral_compare_page_key($region,$tid,0)] ?? null;
                if (is_int($hint) && $hint > 0) $maxPages = min($maxPages, $hint);

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

                $page++;
            } while ($page <= $maxPages);

            // Sort best-first
            usort($buys,  fn($a,$b)=> $b['price'] <=> $a['price']);
            usort($sells, fn($a,$b)=> $a['price'] <=> $b['price']);

            // Trim to max per side
            $buys  = array_slice($buys,  0, EVE_MINERAL_COMPARE_MAX_ORDERS_PER_SIDE);
            $sells = array_slice($sells, 0, EVE_MINERAL_COMPARE_MAX_ORDERS_PER_SIDE);

            // Top-of-book sums with epsilon
            $bbp = $bsp = null; $bbv = $bsv = 0;
            if ($buys)  { $bbp = $buys[0]['price'];  foreach ($buys  as $o) if (abs($o['price'] - $bbp) < EVE_MINERAL_COMPARE_EPS) $bbv += $o['vol']; }
            if ($sells) { $bsp = $sells[0]['price']; foreach ($sells as $o) if (abs($o['price'] - $bsp) < EVE_MINERAL_COMPARE_EPS) $bsv += $o['vol']; }

            // Fallback to stale if both missing
            if (($bbp === null && $bsp === null) && isset($old_cache[$tid][$hub_name])) {
                $fallback = $old_cache[$tid][$hub_name];
                $bbp = is_numeric($fallback['buy']  ?? null) ? (float)$fallback['buy']  : null;
                $bsp = is_numeric($fallback['sell'] ?? null) ? (float)$fallback['sell'] : null;
                $buys  = (isset($fallback['buy_orders'])  && is_array($fallback['buy_orders']))  ? $fallback['buy_orders']  : [];
                $sells = (isset($fallback['sell_orders']) && is_array($fallback['sell_orders'])) ? $fallback['sell_orders'] : [];
                $bbv = is_numeric($fallback['buy_volume']  ?? null) ? (int)$fallback['buy_volume']  : 0;
                $bsv = is_numeric($fallback['sell_volume'] ?? null) ? (int)$fallback['sell_volume'] : 0;
                if ($bbp !== null || $bsp !== null) { $partial = true; $used_stale_backup = true; }
            }

            
            // ---- History-based trends (per region/type) ----
            // Mapping per hub
            $region_id = $region;
            $hist = eve_mc_fetch_market_history($region_id, $tid);

            // Compute trends using ESI history:
            // Buy: compare current highest BUY (bbp) vs avg of previous 7 'lowest' (transaction lows)
            // Sell: compare current lowest SELL (bsp) vs avg of previous 7 'highest' (transaction highs)
            $buyTrend  = eve_mc_compute_buy_trend($hist);
            $sellTrend = eve_mc_compute_sell_trend($hist);

            $final[$tid][$hub_name] = [
                'buy'         => $bbp ?? 'N/A',
                'sell'        => $bsp ?? 'N/A',
                'buy_volume'  => $bbp ? $bbv : null,
                'sell_volume' => $bsp ? $bsv : null,
                'buy_orders'  => $buys,
                'sell_orders' => $sells,
                'trend' => [
                    'buy'  => [
                        'today' => $buyTrend['today'],
                        'avg30'  => $buyTrend['avg30'],
                        'pct'   => isset($buyTrend['pct']) && $buyTrend['pct'] !== null ? round($buyTrend['pct'], 2) : null,
                        'dir'   => $buyTrend['dir']
                    ],
                    'sell' => [
                        'today' => $sellTrend['today'],
                        'avg30'  => $sellTrend['avg30'],
                        'pct'   => isset($sellTrend['pct']) && $sellTrend['pct'] !== null ? round($sellTrend['pct'], 2) : null,
                        'dir'   => $sellTrend['dir']
                    ]
                ]
            ];
        }
    }

    // Persist system map + chunks (atomic) + ETags
    emc_atomic_write_json($map_file, $map);
    $cache_write_ok = (eve_mineral_compare_save_cache_chunks($final) === true);
    eve_mineral_compare_save_etags($etagMap);

    return $final;
}


function eve_mineral_compare_build_table_rows($minerals, $hubs, $data, $type) {
    $rows = [];
    foreach ($minerals as $tid => $name) {
        $vals = [];
        $trends = [];
        $hubNames = [];
        foreach ($hubs as $hub) {
            $hubName = $hub['name'];
            $hubNames[] = $hubName;
            $val = null;
            if (isset($data[$tid][$hubName][$type]) && is_numeric($data[$tid][$hubName][$type])) {
                $val = (float)$data[$tid][$hubName][$type];
            }
            $vals[] = $val;

            // Attach trend object if present
            $t = null;
            if (isset($data[$tid][$hubName]['trend'])) {
                $t = ($type === 'buy') ? ($data[$tid][$hubName]['trend']['buy'] ?? null)
                                       : ($data[$tid][$hubName]['trend']['sell'] ?? null);
            }
            $trends[] = $t;
        }

        // Ranking shades (keep existing behavior)
        $sorted = $vals;
        arsort($sorted);
        $unique = [];
        foreach ($sorted as $i => $v) {
            if ($v === null) continue;
            $found = false;
            foreach ($unique as $u) {
                if (abs($v - $u) < EVE_MINERAL_COMPARE_EPS) { $found = true; break; }
            }
            if (!$found) $unique[] = $v;
            if (count($unique) >= 3) break;
        }
        $tiers = $unique;

        // Build cells with price on first line and trend on second line
        $cells = [];
        foreach ($vals as $idx => $val) {
            $disp = $val === null ? 'N/A' : number_format($val, 2);
            $class = '';
            if ($val !== null) {
                if (isset($tiers[0]) && abs($val - $tiers[0]) < EVE_MINERAL_COMPARE_EPS) $class = 'emc-rank-1';
                elseif (isset($tiers[1]) && abs($val - $tiers[1]) < EVE_MINERAL_COMPARE_EPS) $class = 'emc-rank-2';
                elseif (isset($tiers[2]) && abs($val - $tiers[2]) < EVE_MINERAL_COMPARE_EPS) $class = 'emc-rank-3';
            }

            $t = $trends[$idx] ?? null;
            $trendHtml = '';
            if (is_array($t) && isset($t['pct']) && $t['pct'] !== null) {
                $dir = $t['dir'] ?? 'flat';
                $arrow = ($dir === 'up') ? '▲' : (($dir === 'down') ? '▼' : '◆');
                $cls = ($dir === 'up') ? 'emc-trend-up' : (($dir === 'down') ? 'emc-trend-down' : 'emc-trend-flat');
                $pct = number_format((float)$t['pct'], 2);
                $trendHtml = '<div class="emc-trend-sub"><span class="'.$cls.'">'.$arrow.' '.$pct.'%</span></div>';
            }

            $html = '<div class="emc-price-val">'.esc_html($disp).'</div>'.$trendHtml;
            $cells[] = ['html' => $html, 'class' => $class, 'value' => $disp];
        }

        $rows[] = ['mineral' => $name, 'cells' => $cells];
    }
    return $rows;
}

            
/** Build localized data from cache; prefer fresh, fall back to stale. */
function eve_mineral_compare_prepare_best_trade_data(&$used_stale = false) {
    $minerals = eve_mineral_compare_get_minerals();
    $hubs     = eve_mineral_compare_get_hubs();
    $data     = eve_mineral_compare_load_cache_fresh_or_stale($used_stale);

    $out = [];
    foreach ($minerals as $tid => $name) {
        $out[$tid] = ['name' => $name, 'hubs' => []];
        foreach ($hubs as $hub) {
            $hn = $hub['name'];
            $e  = $data[$tid][$hn] ?? [];
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
    $used_stale = false;
    $cache    = eve_mineral_compare_load_cache_fresh_or_stale($used_stale);
    $buy_rows  = eve_mineral_compare_build_table_rows($minerals, $hubs, $cache, 'buy');
    $sell_rows = eve_mineral_compare_build_table_rows($minerals, $hubs, $cache, 'sell');

    ob_start();
    include __DIR__ . '/template.php';
    return ob_get_clean();
}

/** Enqueue & localize (REST) */
add_action('wp_enqueue_scripts', function () {
    if (is_admin()) {
        return;
    }

    // File locations (plugin root)
    $style_rel  = 'style.css';
    $script_rel = 'script.js';

    $style_path  = plugin_dir_path(__FILE__) . $style_rel;
    $script_path = plugin_dir_path(__FILE__) . $script_rel;

    $style_url  = plugin_dir_url(__FILE__) . $style_rel;
    $script_url = plugin_dir_url(__FILE__) . $script_rel;

    // Bust cache with filemtime if available
    $style_ver  = file_exists($style_path)  ? (string) filemtime($style_path)  : EVE_MINERAL_COMPARE_VERSION;
    $script_ver = file_exists($script_path) ? (string) filemtime($script_path) : EVE_MINERAL_COMPARE_VERSION;

    wp_enqueue_style(
        'eve-mineral-compare-style',
        $style_url,
        [],
        $style_ver
    );

    wp_enqueue_script(
        'eve-mineral-compare-js',
        $script_url,
        ['jquery'],
        $script_ver,
        true
    );

    // Prepare initial trade data from cache (fresh or stale)
    $__used_stale_on_load = false;
    $__extended = eve_mineral_compare_prepare_best_trade_data($__used_stale_on_load);

    // Only allow clearCacheUrl for admins
    $is_admin_capable = current_user_can('manage_options');

    wp_localize_script('eve-mineral-compare-js', 'eveMineralCompare', [
        'isAdmin' => (bool) $is_admin_capable,
        'rest'    => [
            'nonce'         => wp_create_nonce('wp_rest'),
            'refreshUrl'    => esc_url_raw(rest_url('emc/v1/refresh')),
            'tradesUrl'     => esc_url_raw(rest_url('emc/v1/trades')),
            'snapshotUrl'   => esc_url_raw(rest_url('emc/v1/snapshot')),
            'clearCacheUrl' => $is_admin_capable ? esc_url_raw(rest_url('emc/v1/clear-cache')) : '',
        ],
        'extendedTradesData' => $__extended,
        'usedStaleOnLoad'    => $__used_stale_on_load,
    ]);
});

add_shortcode('eve_mineral_compare', function() {
    // Render from cache only
    return eve_mineral_compare_render_tables();
});

function emc_client_key() {
    if (is_user_logged_in()) {
        if (function_exists('wp_get_session_token')) {
            $tok = wp_get_session_token();
            if (!empty($tok)) {
                return 'sess_' . substr(md5($tok), 0, 16);
            }
        }
        return 'user_' . get_current_user_id();
    }
    $tid = isset($_COOKIE['emc_tid']) ? $_COOKIE['emc_tid'] : '';
    if (!empty($tid)) {
        return 'anon_' . substr(md5($tid), 0, 16);
    }
    // Fallback (behind proxies this may be less distinct, but it avoids breaking)
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
    return 'anon_' . md5($ip . '|' . $ua);
}

/** Background refresh action (wp-cron) */
add_action('emc_do_refresh', function(){
    $refreshed = $partial = $used_stale_backup = false; $write_ok = true;
    eve_mineral_compare_update_cache(true, $refreshed, $partial, $used_stale_backup, $write_ok);
});

/** REST endpoints (replace admin-ajax) */
add_action('rest_api_init', function () {
    register_rest_route('emc/v1', '/refresh', [
        'methods'  => 'POST',
        'permission_callback' => '__return_true',
        'callback' => function (\WP_REST_Request $req) {

            // Downtime guard: disable ESI pulls between 10:55 and 11:30 UTC daily
            $nowUtc = new \DateTime('now', new \DateTimeZone('UTC'));
            $hh = (int)$nowUtc->format('H');
            $mm = (int)$nowUtc->format('i');
            $in_window = (($hh === 10 && $mm >= 55) || ($hh === 11 && $mm < 30));
            if ($in_window) {
                // Serve current cache; do not queue or pull from ESI
                $full_html = eve_mineral_compare_render_tables();
                return new \WP_REST_Response([
                    'scheduled'  => false,
                    'message'    => 'ESI pulls are disabled during daily downtime window.',
                    'html'       => $full_html,
                    'extendedTradesData' => eve_mineral_compare_prepare_best_trade_data(),
                    'refreshed'  => false,
                    'used_cache' => true,
                    'busy'       => false,
                    'partial'    => false,
                    'used_stale_backup' => false,
                    'cache_age_seconds' => $cache_age_seconds,
                    'cache_write_ok'    => true,
                    'downtime'   => true,
                    'downtime_lines' => [
                        'ESI pulls disabled between 10:55 and 11:30 UTC (downtime+/-)',
                        'ESI is unreliable during this time'
                    ],
                ], 200);
            }

            // Per-ID short throttle (avoid button spam)
            $key = emc_client_key();
            $transient_key = 'emc_refresh_lock_' . $key;
            if (get_transient($transient_key)) {
                return new \WP_REST_Response(['error'=>'Please wait before refreshing again.'], 429);
            }
            set_transient($transient_key, true, 20);
            
            // Always respect 6h rule: if cache is fresh, DO NOT schedule a refresh
            $first_chunk = eve_mineral_compare_cache_prefix()."_1.json";
            $cache_age_seconds = (file_exists($first_chunk)) ? max(0, time() - filemtime($first_chunk)) : null;
            
            if (eve_mineral_compare_cache_is_fresh()) {
                $full_html = eve_mineral_compare_render_tables();
                return new \WP_REST_Response([
                    'scheduled'  => false,
                    'message'    => 'Cache is still fresh (under 6 hours).',
                    'html'       => $full_html,
                    'extendedTradesData' => eve_mineral_compare_prepare_best_trade_data(),
                    'refreshed'  => false,
                    'used_cache' => true,
                    'busy'       => false,
                    'partial'    => false,
                    'used_stale_backup' => false,
                    'cache_age_seconds' => $cache_age_seconds,
                    'cache_write_ok'    => true,
                ], 200);
            }
            
            // Cache is stale → schedule a refresh once (avoid duplicate scheduling)
                        // Global lock to avoid multiple concurrent refreshes
            if (get_transient('emc_refresh_lock_global')) {
                return new \WP_REST_Response(['error'=>'Refresh already in progress.'], 429, ['Retry-After' => 60]);
            }
            set_transient('emc_refresh_lock_global', true, 90);
if (!wp_next_scheduled('emc_do_refresh')) {
                wp_schedule_single_event(time() + 5, 'emc_do_refresh');
            }
            
            // Return current snapshot while background refresh runs
            $full_html = eve_mineral_compare_render_tables();
            
            return new \WP_REST_Response([
                'scheduled'  => true,
                'message'    => 'Refresh scheduled; latest cache will be served shortly.',
                'html'       => $full_html,
                'extendedTradesData' => eve_mineral_compare_prepare_best_trade_data(),
                'refreshed'  => false,
                'used_cache' => true,
                'busy'       => false,
                'partial'    => false,
                'used_stale_backup' => false,
                'cache_age_seconds' => $cache_age_seconds,
                'cache_write_ok'    => true,
            ], 200);
        }
    ]);

    register_rest_route('emc/v1', '/trades', [
        'methods'  => 'GET',
        'permission_callback' => '__return_true',
        'callback' => function () {
            $first_chunk = eve_mineral_compare_cache_prefix()."_1.json";
            $cache_age_seconds = (file_exists($first_chunk)) ? max(0, time() - filemtime($first_chunk)) : null;
            return new \WP_REST_Response([
                'extendedTradesData' => eve_mineral_compare_prepare_best_trade_data(),
                'cache_age_seconds' => $cache_age_seconds,
            ], 200);
        }
    ]);
    register_rest_route('emc/v1', '/snapshot', [
        'methods'  => 'GET',
        'permission_callback' => '__return_true',
        'callback' => function () {
            $html = eve_mineral_compare_render_tables();
            $first = eve_mineral_compare_cache_prefix()."_1.json";
            $age = (file_exists($first)) ? max(0, time() - filemtime($first)) : null;

            return new \WP_REST_Response([
                'html' => $html,
                'extendedTradesData' => eve_mineral_compare_prepare_best_trade_data(),
                'cache_age_seconds' => $age,
            ], 200);
        }
    ]);
    register_rest_route('emc/v1', '/clear-cache', [
        'methods'  => 'POST',
        'permission_callback' => function () {
            return current_user_can('manage_options');
        },
        // Require REST nonce as well
        'permission_callback' => function (\WP_REST_Request $req) { $nonce = $req->get_header('X-WP-Nonce'); return current_user_can('manage_options') && wp_verify_nonce($nonce, 'wp_rest'); },
        'callback' => function () {
            $dir = eve_mineral_compare_cache_dir();
    
            // Easiest: reuse the helper and then recreate guards
            emc_rrmdir($dir);
            wp_mkdir_p($dir);
            // this repopulates index.html, .htaccess/web.config, README.txt if missing
            eve_mineral_compare_cache_dir();
    
            return new \WP_REST_Response([
                'success' => true,
                'message' => 'Cache cleared.'
            ], 200);
        }
    ]);
});

function emc_check_cache_dir_ok() {
    $dir = eve_mineral_compare_cache_dir();
    $ok = is_dir($dir) && is_writable($dir);
    if (!$ok) {
        add_action('admin_notices', function(){
            echo '<div class="notice notice-error"><p><strong>EVE Mineral Compare:</strong> Cache folder is not writable. Prices may not persist. Check file permissions for <code>wp-content/uploads/eve-mineral-compare/cache/</code>.</p></div>';
        });
    }
}
add_action('admin_init', 'emc_check_cache_dir_ok');

/** Limit REST headers to this plugin's endpoints only */
add_filter('rest_pre_serve_request', function($served, $result, $request, $server){
    // Scope headers only to our endpoints
    try {
        $route = is_object($request) && method_exists($request, 'get_route') ? $request->get_route() : '';
    } catch (\Throwable $e) {
        $route = '';
    }
    if (strpos($route, '/emc/v1/') !== 0) {
        return $served;
    }

    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0', true);
    header('Pragma: no-cache', true);
    header('X-Content-Type-Options: nosniff', true);
    header('X-Robots-Tag: noindex, nofollow', true);
    header('X-Frame-Options: SAMEORIGIN', true);
    header('Referrer-Policy: no-referrer', true);
    return $served;
}, 10, 4);
