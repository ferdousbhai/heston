-- The drawdown high-water mark is retired: the portfolio guard now judges each order against a
-- fresh broker snapshot and reads no stored state, and nothing deployed has read or written this
-- table since that guard shipped. Pushed on its own, as the working rules require for a drop.
DROP TABLE IF EXISTS portfolio_risk_state;
