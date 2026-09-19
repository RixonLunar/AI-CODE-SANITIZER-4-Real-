# OrbitGuard 2.0 — live satellite conjunction screening

## Run on Windows
1. Open this folder in VS Code.
2. Open Terminal.
3. Run `npm install`.
4. Run `npm start`.
5. Open http://localhost:3000 (do not use Live Server / port 5501).

## What is live
- Satellite search uses CelesTrak GP/OMM JSON.
- Analysis retrieves current records for the selected NORAD catalog numbers.
- SGP4/SDP4 propagation is performed server-side with satellite.js.
- The next 24 hours are sampled every 30 seconds, then the closest point is refined at 1-second steps around the best sample.
- The 3D view uses the propagated ECI positions returned by the analysis.
- SOCRATES is loaded from CelesTrak for the selected pair.

## Scientific scope
This is a conjunction-screening prototype. Minimum geometric separation is not the same as an operational collision probability (Pc). Operational decisions require authoritative tracking data, covariance/uncertainty information and the applicable mission assessment process.
