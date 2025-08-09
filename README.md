## EVE Mineral Compare — Version 2.1

### Overview
EVE Mineral Compare is a WordPress shortcode plugin that displays the best buy and sell prices for EVE Online minerals across major trade hubs when the shortcode `[eve_mineral_compare]` is inserted to a post/page.  

It also includes an **Extended Trade Opportunities** simulator, allowing you to compare potential profits between hubs based on your selected **skills**, **standings**, and **volume limits**.  

Data is fetched from the EVE ESI API with smart caching to minimize API calls while keeping information fresh.

Price Data is cached in `wp-content/uploads/eve-mineral-compare/cache`.

---

### Key Features
- **Buy/Sell Price Tables**  
  View mineral prices for all major trade hubs in EVE Online, ranked by best price.

- **Skills & Standings Inputs**  
  Set your in-game Accounting, Broker Relations, Connections, and Diplomacy levels, plus base standings with key NPC entities.
  
- **Extended Trade Simulation**  
  Simulate trades between hubs, applying skill and standing-based fee reductions, volume limits, and a minimum margin filter.

- **No-Undock Trade Simulation**
  See the margin percentage for buying from buy and selling to sell within the same trade hubs.

- **Fee Calculations**  
  Dynamically apply brokerage fees and sales tax per hub based on your inputs.

- **AJAX Price Refresh**  
  Refresh market data without reloading the page — with caching to avoid unnecessary API calls.

- **Volume Limiting**  
  Option to restrict calculations to minerals fitting within 60km³ of cargo space.

- **Mobile-Friendly Layout**  
  Responsive design for both desktop and smaller screens.
