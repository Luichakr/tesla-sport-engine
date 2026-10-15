// Tesla catalog — approximate public figures (mass kg, peak power kW, 0–100 km/h s, top speed km/h, CdA m²).
// Used to judge "how hard" the car is accelerating relative to what it can do at the current speed.
window.TESLAS = [
  { id: 'm3-sr',    name: 'Model 3', trim: 'Standard Range+ / RWD · 2019–23', mass: 1611, kw: 211, t100: 5.6, top: 225, cda: 0.51 },
  { id: 'm3-lr',    name: 'Model 3', trim: 'Long Range AWD · 2019–23',        mass: 1847, kw: 324, t100: 4.4, top: 233, cda: 0.51 },
  { id: 'm3-p',     name: 'Model 3', trim: 'Performance · 2019–23',           mass: 1847, kw: 377, t100: 3.3, top: 261, cda: 0.51 },
  { id: 'm3h-rwd',  name: 'Model 3', trim: 'RWD · 2024+ (Highland)',           mass: 1765, kw: 208, t100: 6.1, top: 201, cda: 0.49 },
  { id: 'm3h-lr',   name: 'Model 3', trim: 'Long Range AWD · 2024+',           mass: 1828, kw: 366, t100: 4.4, top: 201, cda: 0.49 },
  { id: 'm3h-p',    name: 'Model 3', trim: 'Performance · 2024+',              mass: 1836, kw: 460, t100: 3.1, top: 262, cda: 0.49 },
  { id: 'my-rwd',   name: 'Model Y', trim: 'RWD',                              mass: 1909, kw: 220, t100: 6.9, top: 217, cda: 0.62 },
  { id: 'my-lr',    name: 'Model Y', trim: 'Long Range AWD',                   mass: 1979, kw: 378, t100: 5.0, top: 217, cda: 0.62 },
  { id: 'my-p',     name: 'Model Y', trim: 'Performance',                      mass: 1995, kw: 393, t100: 3.7, top: 250, cda: 0.62 },
  { id: 'ms-lr',    name: 'Model S', trim: 'Long Range · 2021+',               mass: 2069, kw: 500, t100: 3.2, top: 250, cda: 0.56 },
  { id: 'ms-plaid', name: 'Model S', trim: 'Plaid',                            mass: 2162, kw: 760, t100: 2.1, top: 322, cda: 0.56 },
  { id: 'mx-lr',    name: 'Model X', trim: 'Long Range · 2021+',               mass: 2352, kw: 500, t100: 3.9, top: 250, cda: 0.67 },
  { id: 'mx-plaid', name: 'Model X', trim: 'Plaid',                            mass: 2455, kw: 750, t100: 2.6, top: 262, cda: 0.67 },
  { id: 'ct-awd',   name: 'Cybertruck', trim: 'AWD',                           mass: 3104, kw: 448, t100: 4.3, top: 180, cda: 1.05 },
  { id: 'ct-beast', name: 'Cybertruck', trim: 'Cyberbeast',                    mass: 3104, kw: 630, t100: 2.9, top: 209, cda: 1.05 },
];
