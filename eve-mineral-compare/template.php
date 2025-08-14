<?php
/**
 * EVE Mineral Compare – Template
 * Renders inputs, tables, and controls.
 */
?>
<div id="eve-mineral-compare-tables">

  <!-- User Inputs -->
  <div id="eve-mineral-user-inputs">
    <div class="emc-skills-col">
      <h4>Skills</h4>

      <label class="emc-user-input-label">
        <span>Accounting</span>
        <select class="emc-skill-select" data-skill="accounting">
          <?php for($i=0;$i<=5;$i++) echo "<option".($i==5?' selected':'').">$i</option>"; ?>
        </select>
      </label>

      <label class="emc-user-input-label">
        <span>Broker Relations</span>
        <select class="emc-skill-select" data-skill="broker_relations">
          <?php for($i=0;$i<=5;$i++) echo "<option".($i==5?' selected':'').">$i</option>"; ?>
        </select>
      </label>

      <label class="emc-user-input-label">
        <span>Connections</span>
        <select class="emc-skill-select" data-skill="connections">
          <?php for($i=0;$i<=5;$i++) echo "<option".($i==5?' selected':'').">$i</option>"; ?>
        </select>
      </label>

      <label class="emc-user-input-label">
        <span>Diplomacy</span>
        <select class="emc-skill-select" data-skill="diplomacy">
          <?php for($i=0;$i<=5;$i++) echo "<option".($i==5?' selected':'').">$i</option>"; ?>
        </select>
      </label>

      <!-- Refresh Button + status -->
      <button id="eve-mineral-refresh" class="emc-refresh-btn">Refresh Prices</button>
      <div id="eve-mineral-status" class="emc-refresh-status" aria-live="polite"></div>
    </div>

    <div class="emc-standings-col">
      <h4>Base Standings</h4>
      <table>
        <thead>
          <tr>
            <th>Entity</th>
            <th>Base</th>
            <th>Effective</th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ([
            'caldari_state'       => 'Caldari State',
            'caldari_navy'        => 'Caldari Navy',
            'amarr_empire'        => 'Amarr Empire',
            'emperor_family'      => 'Emperor Family',
            'minmatar_republic'   => 'Minmatar Republic',
            'brutor_tribe'        => 'Brutor Tribe',
            'gallente_federation' => 'Gallente Federation',
            'federation_navy'     => 'Federation Navy',
            'boundless_creations' => 'Boundless Creations',
          ] as $key=>$label): ?>
            <tr>
              <td><?php echo esc_html($label); ?></td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  min="-10"
                  max="10"
                  inputmode="decimal"
                  class="emc-standing-input emc-decimal-only"
                  data-standing="<?php echo esc_attr($key); ?>" placeholder="0.00">
              </td>
              <td>
                <span class="emc-effective-standing">0.00</span>
              </td>
            </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Brokerage & Sales Tax Summary -->
  <div class="emc-fees-summary-container">
    <h4>Brokerage Fee &amp; Sales Tax</h4>
    <table id="emc-fees-summary" class="emc-table-center emc-table-auto">
      <caption class="screen-reader-text">
        Brokerage fee and sales tax per market hub
      </caption>
      <thead>
        <tr>
          <th>Hub</th>
          <th>Brokerage Fee</th>
          <th>Sales Tax</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <!-- Buy Values Table -->
  <h3 class="emc-section-title">Buy Values</h3>
  <table id="eve-mineral-compare-table-buy" class="emc-main-table">
    <caption class="screen-reader-text">
      Best buy prices per hub for EVE minerals
    </caption>
    <thead>
      <tr>
        <th>Mineral</th>
        <?php foreach (eve_mineral_compare_get_hubs() as $hub): ?>
          <th><?php echo esc_html($hub['name']); ?></th>
        <?php endforeach; ?>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($buy_rows as $row): ?>
        <tr>
          <td><?php echo esc_html($row['mineral']); ?></td>
          <?php foreach ($row['cells'] as $cell): ?>
            <td class="<?php echo esc_attr($cell['class']); ?>">
              <?php echo esc_html($cell['value']); ?>
            </td>
          <?php endforeach; ?>
        </tr>
      <?php endforeach; ?>
    </tbody>
  </table>

  <!-- Sell Values Table -->
  <h3 class="emc-section-title">Sell Values</h3>
  <table id="eve-mineral-compare-table-sell" class="emc-main-table">
    <caption class="screen-reader-text">
      Best sell prices per hub for EVE minerals
    </caption>
    <thead>
      <tr>
        <th>Mineral</th>
        <?php foreach (eve_mineral_compare_get_hubs() as $hub): ?>
          <th><?php echo esc_html($hub['name']); ?></th>
        <?php endforeach; ?>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($sell_rows as $row): ?>
        <tr>
          <td><?php echo esc_html($row['mineral']); ?></td>
          <?php foreach ($row['cells'] as $cell): ?>
            <td class="<?php echo esc_attr($cell['class']); ?>">
              <?php echo esc_html($cell['value']); ?>
            </td>
          <?php endforeach; ?>
        </tr>
      <?php endforeach; ?>
    </tbody>
  </table>

  <!-- Extended Trade Opportunities (Table 3) -->
  <h3 class="emc-section-title">Extended Trade Opportunities</h3>

  <div id="emc-hub-filters-best" class="emc-hub-row">
    <span class="emc-hub-label">Show Hubs:</span>
    <?php foreach (eve_mineral_compare_get_hubs() as $i => $hub):
      $hid = 'emc-hub-'.sanitize_html_class($hub['name']).'-'.$i; ?>
      <label class="emc-hub-item" for="<?php echo esc_attr($hid); ?>">
        <span class="emc-hub-name"><?php echo esc_html($hub['name']); ?></span>
        <input
          id="<?php echo esc_attr($hid); ?>"
          type="checkbox"
          class="emc-hub-toggle"
          value="<?php echo esc_attr($hub['name']); ?>"
          checked>
      </label>
    <?php endforeach; ?>

    <div id="emc-limit-60k-container" class="emc-limit">
      <div class="emc-limit-label">
        <input type="checkbox" id="emc-limit-60k">
        <span>Limit to 6,000,000 units (60,000 m³)</span>
      </div>
      <div class="emc-limit-note">
        <em>Buy from Buy, Sell to Sell defaults to 100,000 units</em>
      </div>
    </div>
  </div>

  <table id="eve-mc-extended" class="emc-main-table">
    <caption class="screen-reader-text">
      Extended trade opportunities with adjustable legs and margin filter
    </caption>
    <thead>
      <tr>
        <th>Mineral</th>
        <th>
          <div class="emc-th-label">Buy From</div>
          <div class="emc-th-control">
            <select id="buy-from-select-ext" class="emc-select">
              <option value="buy">Buy Orders</option>
              <option value="sell">Sell Orders</option>
            </select>
          </div>
        </th>
        <th>
          <div class="emc-th-label">Sell To</div>
          <div class="emc-th-control">
            <select id="sell-to-select-ext" class="emc-select">
              <option value="sell">Sell Orders</option>
              <option value="buy">Buy Orders</option>
            </select>
          </div>
        </th>
        <th>Qty</th>
        <th>Profit</th>
        <th>
          <div class="emc-th-label">Minimum Margin %</div>
          <div class="emc-th-control">
            <input
              type="text"
              id="emc-min-margin"
              class="emc-decimal-only"
              value="5"
              step="0.1"
              inputmode="decimal">
          </div>
        </th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <!-- No Undock Trading (Table 4) -->
  <h3 class="emc-section-title">No-Undock Trading</h3>
  <div class="emc-aux-note">
    Always Buying from Buy, Selling to Sell within the same hub
  </div>

  <table id="emc-no-undock" class="emc-main-table">
    <thead>
      <tr>
        <th>Mineral</th>
        <?php foreach (eve_mineral_compare_get_hubs() as $hub): ?>
          <th><?php echo esc_html($hub['name']); ?></th>
        <?php endforeach; ?>
      </tr>
      <tr>
        <th colspan="<?php echo 1 + count(eve_mineral_compare_get_hubs()); ?>"
            class="screen-reader-text">
          Always Buy from Buy, Sell to Sell
        </th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

</div> <!-- /#eve-mineral-compare-tables -->

<!-- ==========================
     Off-Hub Margin Calculator (advanced)
     ========================== -->
<div class="emc-adv-container">
  <h4>Off-Hub Margin Calculator</h4>

  <div class="emc-adv-controls">
    <label class="emc-adv-inline">
      <span>Brokerage Fee %</span>
      <input
        type="number"
        id="emc-adv-brokerage"
        class="emc-adv-input emc-decimal-only"
        step="0.01"
        min="0"
        value="0"
        inputmode="decimal"
        placeholder="0.00">
    </label>

    <label class="emc-adv-inline">
      <span>Sales Tax %</span>
      <input
        type="number"
        id="emc-adv-tax"
        class="emc-adv-input emc-decimal-only"
        step="0.01"
        min="0"
        value="0"
        inputmode="decimal"
        placeholder="0.00">
    </label>

    <button type="button" id="emc-adv-clear" class="emc-adv-clear">
      Clear All
    </button>
  </div>

  <table id="emc-adv-table" class="emc-main-table">
    <caption class="screen-reader-text">
      Off-hub margin calculator. Enter buy &amp; sell; header toggles control fees.
    </caption>
    <thead>
      <tr>
        <th>Mineral</th>
        <th>
  <div class="emc-adv-headline">Buy</div>
  <div class="emc-adv-colstack">
    <label class="emc-adv-toggle">
      <span>Apply Brokerage</span>
      <input type="checkbox" id="emc-adv-buy-broker" checked>
    </label>
  </div>
</th>
        <th>
  <div class="emc-adv-headline">Sell</div>
  <div class="emc-adv-colstack">
    <label class="emc-adv-toggle">
      <span>Apply Brokerage</span>
      <input type="checkbox" id="emc-adv-sell-broker" checked>
    </label>
    <label class="emc-adv-toggle">
      <span>Apply Sales Tax</span>
      <input type="checkbox" id="emc-adv-sell-tax" checked>
    </label>
  </div>
</th>
        <th>Margin %</th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ([
        'Tritanium','Pyerite','Mexallon','Isogen',
        'Nocxium','Zydrine','Megacyte','Morphite'
      ] as $name): ?>
        <tr>
          <td><?php echo esc_html($name); ?></td>
          <td>
            <input
              type="number"
              step="0.01"
              min="0"
              inputmode="decimal"
              class="emc-adv-input emc-adv-buy emc-decimal-only"
              placeholder="0.00">
          </td>
          <td>
            <input
              type="number"
              step="0.01"
              min="0"
              inputmode="decimal"
              class="emc-adv-input emc-adv-sell emc-decimal-only"
              placeholder="0.00">
          </td>
          <td class="emc-adv-margin emc-td-center">N/A</td>
        </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>
