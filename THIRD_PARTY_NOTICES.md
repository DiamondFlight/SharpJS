# Third-party notices

## SHARPpy

Parts of SharpJS's thermodynamic routines (for example the best-guess precipitation-type logic and several
parcel / moisture helpers) are adapted from SHARPpy, <https://github.com/sharppy/SHARPpy>, under the following
license:

```
Copyright (c) 2011, Patrick T. Marsh & John Hart.
All rights reserved.

Copyright (c) 2012, MetPy Developers.
All rights reserved.

Copyright (c) 2020, Kelton Halbert, Greg Blumberg & Tim Supinie. 
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above
      copyright notice, this list of conditions and the following
      disclaimer in the documentation and/or other materials provided
      with the distribution.

    * Neither the name of the MetPy Developers nor the names of any
      contributors may be used to endorse or promote products derived
      from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## ECAPE

The entraining CAPE (ECAPE) calculations (`src/calc/ecape.js`, `src/calc/ecapeCalc.js`) follow:

- Peters et al., 2022, *Journal of the Atmospheric Sciences* 79(3) (equations 19 and 24 are referenced in the code):
  <https://journals.ametsoc.org/view/journals/atsc/79/3/JAS-D-21-0118.1.xml>

Thanks to Amelia Urquhart (<https://github.com/a-urq>) for help with the ECAPE parcel calculations.

## Data

- **Sample soundings** in `app/public/samples/` and test fixtures are National Weather Service radiosonde
  observations (public domain, U.S. Government work), retrieved from the Iowa Environmental Mesonet.
- **BUFKIT** test fixture: NOAA/NCEP model output (public domain) from the Iowa Environmental Mesonet archive.
- **NEXRAD VWP** test fixture: NOAA NEXRAD Level III data (public domain) from Unidata's archive on AWS.
- **Tornado climatology** tables in `src/data/climo/` were compiled for SharpJS (2003–2024 tornado events).
- The optional loaders in `src/sources/` call free public services run by the
  [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) (Iowa State University) and
  [Unidata](https://www.unidata.ucar.edu/) / the [NOAA Open Data Dissemination program](https://registry.opendata.aws/noaa-nexrad/).
  Their terms of use apply to that data.

## Fonts

The standalone site loads [IBM Plex Sans](https://github.com/IBM/plex) from Google Fonts (SIL Open Font License
1.1). The font is not bundled with SharpJS.
