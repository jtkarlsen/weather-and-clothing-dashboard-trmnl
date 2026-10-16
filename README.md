# Klær etter været

A [TRMNL](https://trmnl.com) plugin that tells kids what to wear today, based on the
forecast from [Yr](https://www.yr.no) (MET Norway's Locationforecast API). All text on
the screen is in Norwegian. It is designed for the **TRMNL X** (1040×780, 16 grays) and
scales down to the original TRMNL and to mashup slots.

![Full view on TRMNL X](docs/full.png)

## What it shows

- The weather on the way to school (07–11) and in the afternoon (12–17), with wind chill
  ("føles som").
- Hour by hour temperature and precipitation, and whether it is dark or light outside.
- An outfit grid where each garment says **Ha på** (wear it), **I sekken** (pack it) or
  **Nei** (not needed), marked M for morning and E for afternoon for the morning and the afternoon.
- A reminder at the bottom, such as the reflector vest when it is dark on the way to school.

After 17:00 the screen switches to tomorrow's plan.

## How it works

| File | Purpose |
|---|---|
| `src/settings.yml` | Polling setup and the form fields (place name, latitude, longitude, time zone) |
| `src/transform.js` | Serverless transform. Turns the Yr forecast into a small outfit plan |
| `src/shared.liquid` | Styles and the SVG icons, shared by every view |
| `src/full.liquid` | Full screen |
| `src/half_horizontal.liquid`, `src/half_vertical.liquid`, `src/quadrant.liquid` | Mashup views |
| `test/` | Tests for the transform, with a sample forecast for Tromsø |

TRMNL polls
`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={{ lat }}&lon={{ lon }}`
every hour with a `User-Agent` that identifies this project, as MET Norway's
[terms of service](https://api.met.no/doc/TermsOfService) require. Coordinates should
have at most four decimals.

The clothing rules live in `outfit()` in `src/transform.js`. They work from the coldest
"feels like" temperature in each part of the day, the precipitation, and whether it is
dark. For example: lined rain gear at 6° or colder, a winter suit in dry frost, mittens
at 4° or colder, and a reflector vest whenever the sun is down.

## Install on TRMNL

With [trmnlp](https://github.com/usetrmnl/trmnlp). The `bin/trmnlp` script in this repo
runs it through Docker, so you only need [Docker](https://docs.docker.com/get-docker/)
running (or `gem install trmnl_preview` with Ruby 4.0+):

```sh
bin/trmnlp login   # paste your API key from trmnl.com > Account
bin/trmnlp push    # creates the private plugin; commit the id it adds to src/settings.yml
bin/trmnlp serve   # local preview at http://localhost:4567
```

Then open the plugin on trmnl.com, set your place and coordinates, and add it to your
playlist.

## Tests

```sh
npm test
```

## Attribution

Weather data from MET Norway (yr.no), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The plugin shows
"Værdata fra Yr / MET Norway" in its title bar.
