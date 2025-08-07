<?php
/**
 * EVE Mineral Compare Table Template
 * Vars provided: $hubs, $buy_table_rows, $sell_table_rows
 */
?>

<div id="eve-mineral-compare-table">
    <h3 class="eve-mineral-title">Buy value</h3>
    <table class="eve-mineral-table">
        <tr>
            <th>Mineral</th>
            <?php foreach ($hubs as $hub): ?>
                <th><?php echo esc_html($hub['name']); ?></th>
            <?php endforeach; ?>
        </tr>
        <?php foreach ($buy_table_rows as $row): ?>
            <tr>
                <td><?php echo esc_html($row['mineral']); ?></td>
                <?php foreach ($row['cells'] as $cell): ?>
                    <td style="<?php echo esc_attr($cell['style']); ?>">
                        <?php echo esc_html($cell['value']); ?>
                    </td>
                <?php endforeach; ?>
            </tr>
        <?php endforeach; ?>
    </table>

    <h3 class="eve-mineral-title">Sell value</h3>
    <table class="eve-mineral-table">
        <tr>
            <th>Mineral</th>
            <?php foreach ($hubs as $hub): ?>
                <th><?php echo esc_html($hub['name']); ?></th>
            <?php endforeach; ?>
        </tr>
        <?php foreach ($sell_table_rows as $row): ?>
            <tr>
                <td><?php echo esc_html($row['mineral']); ?></td>
                <?php foreach ($row['cells'] as $cell): ?>
                    <td style="<?php echo esc_attr($cell['style']); ?>">
                        <?php echo esc_html($cell['value']); ?>
                    </td>
                <?php endforeach; ?>
            </tr>
        <?php endforeach; ?>
    </table>
</div>
<div class="eve-mineral-refresh-wrap">
  <button id="eve-mineral-refresh" type="button">Refresh Prices</button>
  <div id="eve-mineral-status"></div>
</div>
