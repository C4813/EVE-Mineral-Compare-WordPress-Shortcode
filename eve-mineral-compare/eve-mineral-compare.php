<?php
/*
Plugin Name: EVE Mineral Compare
Description: Shows best buy/sell prices for EVE minerals at major trade hubs, with AJAX refresh and caching.
Version: 1.0
Author: Your Name
*/

// --- Plugin Constants ---
define('EVE_MINERAL_COMPARE_VERSION', '1.0');
define('EVE_MINERAL_COMPARE_CACHE_AGE', 6 * 3600); // 6 hours

// --- Data Arrays (for plugin and template) ---
function eve_mineral_compare_get_minerals() {
    return [
        34 => 'Tritanium', 35 => 'Pyerite', 36 => 'Mexallon', 37 => 'Isogen',
        38 => 'Nocxium', 39 => 'Zydrine', 40 => 'Megacyte', 11399 => 'Morphite',
    ];
}
function eve_mineral_compare_get_hubs() {
    return [
        [ 'region_id' => 10000002, 'name' => 'Jita',    'systems' => [30000142, 30000144] ],
        [ 'region_id' => 10000043, 'name' => 'Amarr',   'systems' => [30002187, 30003491] ],
        [ 'region_id' => 10000030, 'name' => 'Rens',    'systems' => [30002510, 30002526] ],
        [ 'region_id' => 10000042, 'name' => 'Hek',     'systems' => [30002053, 30002068] ],
        [ 'region_id' => 10000032, 'name' => 'Dodixie', 'systems' => [30002659, 30002661] ],
    ];
}

// --- Enqueue CSS/JS only when shortcode is present ---
add_action('wp_enqueue_scripts', function() {
    if (is_singular() && has_shortcode(get_post()->post_content, 'eve_mineral_compare')) {
        wp_enqueue_style(
            'eve-mineral-compare-style',
            plugins_url('style.css', __FILE__),
            [],
            EVE_MINERAL_COMPARE_VERSION
        );
        wp_register_script(
            'eve-mineral-compare-ajax',
            '',
            ['jquery'],
            EVE_MINERAL_COMPARE_VERSION,
            true
        );
        wp_add_inline_script('eve-mineral-compare-ajax', "
            jQuery(document).ready(function($) {
                $(document).on('click', '#eve-mineral-refresh', function(e){
                    e.preventDefault();
                    var btn = $(this);
                    btn.prop('disabled', true).text('Refreshing...');
                    $('#eve-mineral-status').text('');
                    $.post(eveMineralCompare.ajaxurl, { action: 'eve_mineral_compare_refresh', nonce: eveMineralCompare.nonce }, function(data){
                        btn.prop('disabled', false).text('Refresh Prices');
                        if(data.success){
                            $('#eve-mineral-compare-table').html($(data.data.tables).find('#eve-mineral-compare-table').html());
                            $('#eve-mineral-status').text(data.data.refreshed
                          ? 'Prices updated!'
                          : 'Prices not updated, cache is <6 hours old!'
                        );

                        }else{
                            $('#eve-mineral-status').text('Error refreshing data.');
                        }
                    }).fail(function(xhr){
                        btn.prop('disabled', false).text('Refresh Prices');
                        $('#eve-mineral-status').text('AJAX error: ' + xhr.status);
                    });
                });
            });
        ");
        wp_localize_script('eve-mineral-compare-ajax', 'eveMineralCompare', [
            'ajaxurl' => admin_url('admin-ajax.php'),
            'nonce'   => wp_create_nonce('eve_mineral_compare_refresh'),
        ]);
        wp_enqueue_script('eve-mineral-compare-ajax');
    }
});

// --- Shortcode handler ---
add_shortcode('eve_mineral_compare', function() {
    ob_start();
    echo eve_mineral_compare_render_tables();
    return ob_get_clean();
});

// --- AJAX handler (feedback if cache was refreshed) ---
add_action('wp_ajax_eve_mineral_compare_refresh', 'eve_mineral_compare_refresh_callback');
add_action('wp_ajax_nopriv_eve_mineral_compare_refresh', 'eve_mineral_compare_refresh_callback');
function eve_mineral_compare_refresh_callback() {
    check_ajax_referer('eve_mineral_compare_refresh', 'nonce');
    $refreshed = false;
    eve_mineral_compare_update_cache(false, $refreshed);
    $tables = eve_mineral_compare_render_tables();
    wp_send_json_success([
        'tables'    => $tables,
        'refreshed' => $refreshed
    ]);
}

// --- Build display tables and load template ---
function eve_mineral_compare_render_tables() {
    $minerals = eve_mineral_compare_get_minerals();
    $hubs     = eve_mineral_compare_get_hubs();
    $cache_data = eve_mineral_compare_update_cache(false);

    $buy_table_rows  = eve_mineral_compare_build_table_rows($minerals, $hubs, $cache_data, 'buy');
    $sell_table_rows = eve_mineral_compare_build_table_rows($minerals, $hubs, $cache_data, 'sell');

    ob_start();
    include plugin_dir_path(__FILE__) . 'template.php';
    return ob_get_clean();
}

// --- Format values and color for display ---
function eve_mineral_compare_build_table_rows($minerals, $hubs, $cache_data, $table_type) {
    $rows = [];
    foreach ($minerals as $type_id => $mineral_name) {
        $row_values = [];
        foreach ($hubs as $hub) {
            $val = $cache_data[$type_id][$hub['name']][$table_type] ?? null;
            $row_values[] = is_numeric($val) ? floatval($val) : null;
        }
        $filtered = array_filter($row_values, fn($v) => $v !== null);
        $max = $filtered ? max($filtered) : null;
        $min = $filtered ? min($filtered) : null;
        $cells = [];
        foreach ($row_values as $val) {
            if ($val === null) {
                $display = 'N/A';
            } elseif (floor($val) == $val) {
                $display = number_format($val, 0);
            } else {
                $display = number_format($val, 2);
            }
            $style = '';
            if ($val !== null && $max !== null && $max > 0 && $max != $min) {
                $percent = ($val - $min) / ($max - $min);
                $opacity = round($percent * 0.8 + 0.2, 2); // 0.2 to 1.0
                $style = "background: rgba(183,247,176,{$opacity});";
            } elseif ($val === $max && $max > 0) {
                $style = "background: rgba(183,247,176,1);";
            }
            $cells[] = [
                'value' => $display,
                'style' => $style,
            ];
        }
        $rows[] = [
            'mineral' => $mineral_name,
            'cells' => $cells,
        ];
    }
    return $rows;
}

// --- File-based cache: writes only if expired; $refreshed is true if updated ---
function eve_mineral_compare_update_cache($force = false, &$refreshed = null) {
    $upload_dir = wp_upload_dir();
    $cache_dir  = $upload_dir['basedir'] . '/eve-mineral-compare/cache/';
    $cache_file = $cache_dir . 'market_cache.json';
    $minerals   = eve_mineral_compare_get_minerals();
    $hubs       = eve_mineral_compare_get_hubs();

    if (!file_exists($cache_dir)) wp_mkdir_p($cache_dir);

    $needs_refresh = $force || !file_exists($cache_file) || (filemtime($cache_file) < (time() - EVE_MINERAL_COMPARE_CACHE_AGE));
    if ($needs_refresh) {
        $refreshed = true;
        $data = [];
        foreach ($minerals as $type_id => $mineral_name) $data[$type_id] = [ 'name' => $mineral_name ];
        foreach ($hubs as $hub) {
            $orders = [];
            $page = 1;
            $pages = 1;
            do {
                $url = "https://esi.evetech.net/latest/markets/{$hub['region_id']}/orders/?page={$page}";
                $resp = wp_remote_get($url, ['timeout' => 30]);
                if (is_wp_error($resp)) break;
                $page_orders = json_decode(wp_remote_retrieve_body($resp), true);
                if (is_array($page_orders)) $orders = array_merge($orders, $page_orders);
                $pages = intval(wp_remote_retrieve_header($resp, 'x-pages')) ?: 1;
                $page++;
            } while ($page <= $pages);

            foreach ($minerals as $type_id => $mineral_name) {
                $buy_prices = [];
                $sell_prices = [];
                foreach ($orders as $order) {
                    if ($order['type_id'] == $type_id && in_array($order['system_id'], $hub['systems'])) {
                        if ($order['is_buy_order']) $buy_prices[] = $order['price'];
                        else $sell_prices[] = $order['price'];
                    }
                }
                $best_buy  = $buy_prices  ? max($buy_prices)  : 'N/A';
                $best_sell = $sell_prices ? min($sell_prices) : 'N/A';
                $data[$type_id][$hub['name']] = ['buy' => $best_buy, 'sell' => $best_sell];
            }
        }
        file_put_contents($cache_file, json_encode($data));
        return $data;
    } else {
        $refreshed = false;
        $json = file_get_contents($cache_file);
        return json_decode($json, true);
    }
}
