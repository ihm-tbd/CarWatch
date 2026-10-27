# Car Tracker data (sample)

This is sample data so the app has something to show out of the box. The
figures below are fictional — made up for this demo, not a real price
quote for any vehicle. Replace this file (or edit it in place) with your
own car, configurations, price points, quotes, and incentives. See
README.md for the file format.

## Cars
- id: demo-car | make: Example Motors | model: Roadster | years: 2026 | trims: Base | conditions: new | zip: | created: | check_interval_days: 14 | last_checked:

## Configurations
- id: demo-car-2026-base | car: demo-car | year: 2026 | trim: Base | condition: new

## Price points
- id: pp1 | configuration: demo-car-2026-base | value: 32000 | basis: msrp | destination: excluded | sample_size: | range_low: | range_high: | source: Manufacturer pricing page (sample data) | source_url: | confirmed: yes | observed: 2026-01-05 | note:
- id: pp2 | configuration: demo-car-2026-base | value: 31500 | basis: listing | destination: | sample_size: 1 | range_low: | range_high: | source: Sample listing (fictional) | source_url: | confirmed: yes | observed: 2026-01-19 | note:

## Quotes

No quotes logged yet. Quotes are user-entered only — one line per quote:
`- id: <id> | configuration: <configuration id> | value: <number> | dealer: <text> | quoted: YYYY-MM-DD | note: <text>`

## Incentives
- id: inc1 | car: demo-car | kind: apr | headline: 0% APR for 36 months (sample incentive) | terms: | amount: | apr_terms: 0% APR for 36 months | provider: Example Motors Financial | source: Sample data | confirmed: yes | expires: 2026-12-31 | applies_to: demo-car-2026-base
