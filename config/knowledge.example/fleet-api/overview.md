---
title: What fleet-api is for
tags: [context, domain]
---

fleet-api runs a city bike-share: it tracks every dock, every bike, and every
ride from unlock to return. Riders never call it directly; the rider app,
the kiosk screens at each station, and the operations dashboard all do.

A dock is the unit of truth. A bike's location is whatever dock last
reported it locked in, or "in ride" between an unlock and a lock. When the
two disagree (a dock says a bike is present, but its ride never closed),
the dock wins and the ride is closed at that dock.

E-bikes are being added to the fleet this season, so battery charge is now
part of a bike's state. Code that picks a bike for a rider must skip e-bikes
below the minimum charge, not just broken bikes.
