## EVE Mineral Compare — Version 4.1

### Overview
EVE Mineral Compare is a WordPress shortcode plugin that displays the best buy and sell prices for EVE Online minerals across major trade hubs when the shortcode `[eve_mineral_compare]` is inserted to a post/page.  

It also includes an **Extended Trade Opportunities** simulator, allowing you to compare potential profits between hubs based on your selected **skills**, **standings**, and **volume limits**.  

Data is fetched from the EVE ESI API with smart caching to minimize API calls while keeping information fresh.

*Please note that the plugin is hard-coded not to send any ESI requests between 10:55 and 11:30 UTC due to ESI being unreliable during down-time*

Price Data is cached in `wp-content/uploads/eve-mineral-compare/cache`.

*Due to the nature of the plugin, the shortcode should only be used on pages or posts. Functionality and display cannot be guaranteed if used in other locations, such as, sidebar widget blocks.*

---

### Key Features
- **Buy/Sell Price Tables**  
  View mineral prices for all major trade hubs in EVE Online, ranked by best price.<br>
  30 day trends are displayed under every price

- **Skills & Standings Inputs**  
  Set your in-game Accounting, Broker Relations, Connections, and Diplomacy levels, plus base standings with key NPC entities.
  
- **Extended Trade Opportunities Simulation**  
  Simulate trades between hubs, applying skill and standing-based fee reductions, volume limits, and a minimum margin filter.

- **No-Undock Trade Simulation**
  See the margin percentage for buying from buy and selling to sell within the same trade hub.

- **Off-Hub Margin Calculation**
  Enter custom brokerage fees / sales tax and buy/sell values for minerals to see the margin. This is useful for buying low outside of a trade hub and selling high elsewhere/at a trade hub.

- **Fee Calculations**  
  Dynamically apply brokerage fees and sales tax per hub based on your inputs.

- **AJAX Price Refresh**  
  Refresh market data without reloading the page — with caching to avoid unnecessary API calls.
