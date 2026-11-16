# TransLoc (Ride Systems) sample data

Captured 2026-11-11 ~5:05 PM ET from the public tracker at https://uva.transloc.com/routes
(found via F12 → Network → Fetch/XHR). These endpoints are **undocumented** and could change.

> The sample `.json` files themselves are **not included** in the public repo (they're TransLoc's data). Capture your own the same way if you need them.

Base URL: `https://uva.transloc.com/Services/JSONPRelay.svc/`
`{apiKey}` = the tracker's public page key, stored as `TRANSLOC_API_KEY` in `.env`.

| File | Endpoint | Tracker polls? | Contents |
|---|---|---|---|
| `sample-vehicles.json` | `GetMapVehiclePoints?apiKey={apiKey}&isPublicMap=true` | every few sec | 21 buses: `VehicleID`, `RouteID`, `Latitude`, `Longitude`, `Heading`, `GroundSpeed`, `IsDelayed`, `IsOnRoute`, `TimeStamp` |
| `sample-routes.json` | `GetRoutesForMapWithScheduleWithEncodedLine?apiKey={apiKey}&isDispatch=false` | once on load | 15 routes: `RouteID`, `Description` (name), `MapLineColor`, `EncodedPolyline` (Google polyline format), `IsRunning`, `Stops` (list) |
| `sample-capacities.json` | `GetVehicleCapacities` (no key needed) | every few sec | per bus: `Capacity`, `CurrentOccupation`, `Percentage` |
| `sample-arrivals.json` | `GetStopArrivalTimes?apiKey={apiKey}&stopIds=10&version=2` | when a stop is tapped, then repeats | per route at the stop: `RouteId`, `RouteDescription`, `Color`, `StopDescription`, `Times[]` with `Seconds` (countdown), `VehicleId`, `IsArriving`, `OnTimeStatus` |

Notes:
- `TimeStamp` is Microsoft's date format: `/Date(1794459910000-0700)/` = milliseconds since 1970.
- Vehicles link to routes by `RouteID`, and to capacities by `VehicleID`.
- Stops live inside each route's `Stops` list; a stop's `AddressID` matches `StopId` / `stopIds` in arrivals (stop 10 = "Alderman Rd @ O-Hill Dining Hall").
- `stopIds` is plural, so it may accept several IDs at once (handy for favorites). Not yet tested.
- Other requests seen but not needed: `GetMapConfig`, `GetViewportInfo`, `GetTwitterJSON`, Google Analytics `collect`.
