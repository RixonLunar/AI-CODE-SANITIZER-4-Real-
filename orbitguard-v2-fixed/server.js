import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as satellite from 'satellite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const CELESTRAK = 'https://celestrak.org';

const cache = new Map();
const TTL = 5 * 60 * 1000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));


/* =========================================================
   CelesTrak HTTP / JSON
========================================================= */

async function fetchCelestrak(url) {

  console.log('\n----------------------------------------');
  console.log('CelesTrak request:');
  console.log(url);

  const cached = cache.get(url);

  if (cached && Date.now() - cached.time < TTL) {
    console.log('Using cached response.');
    return cached.data;
  }

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'OrbitGuard-Buildathon/2.0'
    }
  });

  const text = await response.text();

  console.log(
    `CelesTrak HTTP status: ${response.status}`
  );

  if (!response.ok) {

    console.error(
      'CelesTrak error:',
      text.slice(0, 500)
    );

    throw new Error(
      `CelesTrak HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }

  let data;

  try {

    data = JSON.parse(text);

  } catch (error) {

    console.error(
      'CelesTrak returned invalid JSON:'
    );

    console.error(
      text.slice(0, 500)
    );

    throw new Error(
      `CelesTrak returned non-JSON data: ${text.slice(0, 300)}`
    );
  }

  cache.set(url, {
    time: Date.now(),
    data
  });

  return data;
}


/* =========================================================
   Convert CelesTrak response to a record
========================================================= */

function firstRecord(data) {

  if (Array.isArray(data)) {

    if (data.length === 0) {
      return null;
    }

    return data[0];
  }

  if (
    data &&
    typeof data === 'object'
  ) {
    return data;
  }

  return null;
}


/* =========================================================
   Get one satellite
========================================================= */

async function getSatellite(catalogNumber) {

  const id =
    String(catalogNumber || '').trim();

  if (!/^\d+$/.test(id)) {

    throw new Error(
      `Invalid NORAD catalog number: ${id}`
    );
  }

  const url =
    `${CELESTRAK}/NORAD/elements/gp.php?` +
    new URLSearchParams({
      CATNR: id,
      FORMAT: 'JSON'
    });


  const data =
    await fetchCelestrak(url);


  const record =
    firstRecord(data);


  if (!record) {

    throw new Error(
      `CelesTrak returned no satellite record for NORAD ${id}.`
    );
  }


  /*
    Normalize the catalog number immediately.

    CelesTrak currently uses NORAD_CAT_ID,
    but we accept several possible field names
    for robustness.
  */

  const norad =
    Number(
      record.NORAD_CAT_ID ??
      record.CATALOG_NUMBER ??
      record.NORAD_CATID ??
      record.NORAD_CAT_ID_1 ??
      0
    );


  if (!norad) {

    console.error(
      'Satellite record did not contain a NORAD ID:',
      record
    );

    throw new Error(
      `Satellite ${id} was returned but its NORAD catalog number is missing.`
    );
  }


  /*
    Make sure satellite.js receives the expected
    OMM/GP object.
  */

  record.NORAD_CAT_ID = norad;


  console.log(
    `Satellite loaded: ${record.OBJECT_NAME || 'Unknown'}`
  );

  console.log(
    `NORAD: ${norad}`
  );

  console.log(
    `Epoch: ${record.EPOCH || 'unknown'}`
  );


  return record;
}


/* =========================================================
   Safe satellite normalization
========================================================= */

function normalize(record) {

  if (!record) {

    return {
      name: 'Unknown',
      catalogNumber: 0,
      objectId: '',
      epoch: '',
      intlDesignator: '',
      raw: {}
    };
  }


  const id =
    Number(
      record.NORAD_CAT_ID ??
      record.CATALOG_NUMBER ??
      record.NORAD_CATID ??
      0
    );


  return {

    name:
      record.OBJECT_NAME ||
      record.OBJECT_NAME_1 ||
      'Unknown',

    catalogNumber:
      id,

    objectId:
      record.OBJECT_ID ||
      '',

    epoch:
      record.EPOCH ||
      '',

    intlDesignator:
      record.OBJECT_ID ||
      '',

    raw:
      record
  };
}


/* =========================================================
   Health
========================================================= */

app.get(
  '/api/health',
  (req, res) => {

    res.json({
      ok: true,
      service: 'OrbitGuard',
      time: new Date().toISOString()
    });

  }
);


/* =========================================================
   Satellite Search
========================================================= */

app.get(
  '/api/search',
  async (req, res) => {

    try {

      const q =
        String(
          req.query.q || ''
        ).trim();


      if (!q) {

        return res.json({
          results: []
        });

      }


      /*
        ISS shortcut.

        The actual ISS is NORAD 25544.
      */

      if (/^ISS$/i.test(q)) {

        const iss =
          await getSatellite('25544');


        return res.json({

          results: [
            normalize(iss)
          ],

          source:
            `${CELESTRAK}/NORAD/elements/gp.php?CATNR=25544&FORMAT=JSON`

        });

      }


      /*
        Numeric search.
      */

      const query =
        /^\d+$/.test(q)
          ? `CATNR=${encodeURIComponent(q)}`
          : `NAME=${encodeURIComponent(q)}`;


      const url =
        `${CELESTRAK}/NORAD/elements/gp.php?` +
        `${query}&FORMAT=JSON`;


      const data =
        await fetchCelestrak(url);


      let records =
        Array.isArray(data)
          ? data
          : [data];


      /*
        Remove invalid entries.
      */

      records =
        records.filter(
          item =>
            item &&
            typeof item === 'object'
        );


      /*
        Search ranking.
      */

      const search =
        q.toUpperCase();


      records.sort(
        (a, b) => {

          const nameA =
            String(
              a.OBJECT_NAME || ''
            ).toUpperCase();


          const nameB =
            String(
              b.OBJECT_NAME || ''
            ).toUpperCase();


          let scoreA = 0;
          let scoreB = 0;


          if (nameA === search) {
            scoreA += 100;
          }

          if (nameB === search) {
            scoreB += 100;
          }


          if (nameA.startsWith(search)) {
            scoreA += 50;
          }

          if (nameB.startsWith(search)) {
            scoreB += 50;
          }


          if (nameA.includes(search)) {
            scoreA += 10;
          }

          if (nameB.includes(search)) {
            scoreB += 10;
          }


          return scoreB - scoreA;

        }
      );


      res.json({

        results:
          records
            .slice(0, 50)
            .map(normalize),

        source: url

      });


    } catch (error) {

      console.error(
        '\nSEARCH ERROR:'
      );

      console.error(
        error
      );


      res.status(502).json({

        error:
          'Satellite search failed',

        detail:
          error.message

      });

    }

  }
);


/* =========================================================
   satellite.js
========================================================= */

function createSatrec(record) {

  if (!record) {

    throw new Error(
      'Cannot create satellite record: record is undefined.'
    );

  }


  console.log(
    `Creating SGP4 record for ${
      record.OBJECT_NAME || 'Unknown'
    }`
  );


  try {

    return satellite.json2satrec(
      record
    );

  } catch (error) {

    console.error(
      'satellite.js error:',
      error
    );

    throw new Error(
      `satellite.js could not parse ${
        record.OBJECT_NAME || 'satellite'
      }: ${error.message}`
    );

  }

}


/* =========================================================
   State propagation
========================================================= */

function stateAt(
  satrec,
  date
) {

  const state =
    satellite.propagate(
      satrec,
      date
    );


  if (
    !state ||
    !state.position ||
    !state.velocity
  ) {

    throw new Error(
      `Propagation failed at ${date.toISOString()}`
    );

  }


  return state;
}


/* =========================================================
   Distance / relative velocity
========================================================= */

function calculateMetrics(
  recA,
  recB,
  date
) {

  const stateA =
    stateAt(
      recA,
      date
    );


  const stateB =
    stateAt(
      recB,
      date
    );


  const dx =
    stateA.position.x -
    stateB.position.x;


  const dy =
    stateA.position.y -
    stateB.position.y;


  const dz =
    stateA.position.z -
    stateB.position.z;


  const dvx =
    stateA.velocity.x -
    stateB.velocity.x;


  const dvy =
    stateA.velocity.y -
    stateB.velocity.y;


  const dvz =
    stateA.velocity.z -
    stateB.velocity.z;


  return {

    distanceKm:
      Math.hypot(
        dx,
        dy,
        dz
      ),

    relativeVelocityKmS:
      Math.hypot(
        dvx,
        dvy,
        dvz
      ),

    a: {
      x: stateA.position.x,
      y: stateA.position.y,
      z: stateA.position.z
    },

    b: {
      x: stateB.position.x,
      y: stateB.position.y,
      z: stateB.position.z
    }

  };

}


/* =========================================================
   LIVE CONJUNCTION ANALYSIS
========================================================= */

app.post(
  '/api/analyze',
  async (req, res) => {

    try {

      console.log(
        '\n\n========================================'
      );

      console.log(
        'ORBITGUARD LIVE ANALYSIS'
      );

      console.log(
        '========================================'
      );


      const {
        catalogA,
        catalogB,
        hours = 24,
        stepSeconds = 30,
        thresholdKm = 5
      } =
        req.body || {};


      console.log(
        'Requested Satellite A:',
        catalogA
      );

      console.log(
        'Requested Satellite B:',
        catalogB
      );


      /*
        Validate.
      */

      if (
        !catalogA ||
        !catalogB
      ) {

        return res.status(400).json({

          error:
            'Select two satellites.'

        });

      }


      if (
        String(catalogA) ===
        String(catalogB)
      ) {

        return res.status(400).json({

          error:
            'Select two different satellites.'

        });

      }


      const idA =
        String(catalogA).trim();


      const idB =
        String(catalogB).trim();


      if (
        !/^\d+$/.test(idA) ||
        !/^\d+$/.test(idB)
      ) {

        return res.status(400).json({

          error:
            'Invalid NORAD catalog numbers.'

        });

      }


      const analysisHours =
        Math.min(
          Math.max(
            Number(hours) || 24,
            1
          ),
          168
        );


      const step =
        Math.min(
          Math.max(
            Number(stepSeconds) || 30,
            1
          ),
          3600
        );


      const threshold =
        Math.max(
          Number(thresholdKm) || 5,
          0.01
        );


      /*
        ---------------------------------------------------
        GET SATELLITES SEPARATELY
        ---------------------------------------------------
      */

      console.log(
        `\nLoading Satellite A ${idA}...`
      );


      const satelliteA =
        await getSatellite(idA);


      console.log(
        `\nLoading Satellite B ${idB}...`
      );


      const satelliteB =
        await getSatellite(idB);


      /*
        Hard validation before normalize().
      */

      if (!satelliteA) {

        throw new Error(
          `Satellite A (${idA}) is undefined.`
        );

      }


      if (!satelliteB) {

        throw new Error(
          `Satellite B (${idB}) is undefined.`
        );

      }


      console.log(
        '\nSatellite A:',
        satelliteA.OBJECT_NAME,
        satelliteA.NORAD_CAT_ID
      );


      console.log(
        'Satellite B:',
        satelliteB.OBJECT_NAME,
        satelliteB.NORAD_CAT_ID
      );


      /*
        Create SGP4 records.
      */

      const recA =
        createSatrec(
          satelliteA
        );


      const recB =
        createSatrec(
          satelliteB
        );


      /*
        Analysis start.
      */

      const start =
        new Date();


      let best = null;

      const samples = [];


      const totalSteps =
        Math.round(
          analysisHours *
          3600 /
          step
        );


      console.log(
        `\nScreening ${analysisHours} hours`
      );

      console.log(
        `Step: ${step} seconds`
      );

      console.log(
        `Samples: ${totalSteps + 1}`
      );


      /*
        Main propagation.
      */

      for (
        let i = 0;
        i <= totalSteps;
        i++
      ) {

        const date =
          new Date(
            start.getTime() +
            i *
            step *
            1000
          );


        const metric =
          calculateMetrics(
            recA,
            recB,
            date
          );


        samples.push({

          time:
            date.toISOString(),

          distanceKm:
            Number(
              metric.distanceKm.toFixed(6)
            ),

          relativeVelocityKmS:
            Number(
              metric.relativeVelocityKmS.toFixed(6)
            )

        });


        if (
          !best ||
          metric.distanceKm <
          best.distanceKm
        ) {

          best = {

            ...metric,

            time: date

          };

        }

      }


      if (!best) {

        throw new Error(
          'No valid propagation samples were produced.'
        );

      }


      console.log(
        `\nInitial closest approach: ${best.distanceKm.toFixed(6)} km`
      );

      console.log(
        `Initial TCA: ${best.time.toISOString()}`
      );


      /*
        Refine closest approach
        to one-second resolution.
      */

      const refineStart =
        new Date(
          best.time.getTime() -
          90 * 1000
        );


      let refined =
        best;


      for (
        let second = 0;
        second <= 180;
        second++
      ) {

        const date =
          new Date(
            refineStart.getTime() +
            second *
            1000
          );


        const metric =
          calculateMetrics(
            recA,
            recB,
            date
          );


        if (
          metric.distanceKm <
          refined.distanceKm
        ) {

          refined = {

            ...metric,

            time: date

          };

        }

      }


      console.log(
        `\nREFINED MINIMUM: ${refined.distanceKm.toFixed(6)} km`
      );

      console.log(
        `REFINED TCA: ${refined.time.toISOString()}`
      );

      console.log(
        `RELATIVE SPEED: ${refined.relativeVelocityKmS.toFixed(6)} km/s`
      );


      /*
        3D orbit positions.
      */

      const orbitPositions = [];

      const orbitSamples = 180;


      for (
        let i = 0;
        i <= orbitSamples;
        i++
      ) {

        const date =
          new Date(
            start.getTime() +
            i *
            (
              analysisHours *
              3600 *
              1000 /
              orbitSamples
            )
          );


        const metric =
          calculateMetrics(
            recA,
            recB,
            date
          );


        orbitPositions.push({

          time:
            date.toISOString(),

          a: {

            x:
              Number(
                metric.a.x.toFixed(6)
              ),

            y:
              Number(
                metric.a.y.toFixed(6)
              ),

            z:
              Number(
                metric.a.z.toFixed(6)
              )

          },

          b: {

            x:
              Number(
                metric.b.x.toFixed(6)
              ),

            y:
              Number(
                metric.b.y.toFixed(6)
              ),

            z:
              Number(
                metric.b.z.toFixed(6)
              )

          }

        });

      }


      /*
        Normalize only after all validation.
      */

      const objectA =
        normalize(
          satelliteA
        );


      const objectB =
        normalize(
          satelliteB
        );


      /*
        Final report.
      */

      const response = {

        generatedAt:
          new Date().toISOString(),

        windowHours:
          analysisHours,

        stepSeconds:
          step,

        samplesCount:
          samples.length,

        thresholdKm:
          threshold,


        closeApproach:
          refined.distanceKm <= threshold,


        minimumSeparationKm:
          Number(
            refined.distanceKm.toFixed(6)
          ),


        minimumSeparationMeters:
          Number(
            (
              refined.distanceKm *
              1000
            ).toFixed(2)
          ),


        tca:
          refined.time.toISOString(),


        relativeVelocityKmS:
          Number(
            refined.relativeVelocityKmS.toFixed(6)
          ),


        relativeVelocityMPS:
          Number(
            (
              refined.relativeVelocityKmS *
              1000
            ).toFixed(2)
          ),


        objectA,

        objectB,


        samples,


        orbitPositions,


        source:
          'CelesTrak GP/OMM + satellite.js SGP4/SDP4',


        methodology:
          'Live CelesTrak GP/OMM orbital elements were propagated using satellite.js. The analysis samples the requested time window and refines the closest sampled approach to one-second resolution.',


        warning:
          'This is a geometric screening result, not an operational mission-specific collision probability. Operational conjunction assessment requires appropriate covariance and mission data.'

      };


      console.log(
        '\n========================================'
      );

      console.log(
        'ANALYSIS SUCCESSFUL'
      );

      console.log(
        '========================================\n'
      );


      res.json(
        response
      );


    } catch (error) {

      console.error(
        '\n========================================'
      );

      console.error(
        'ANALYSIS FAILED'
      );

      console.error(
        error
      );

      console.error(
        '========================================\n'
      );


      res.status(502).json({

        error:
          'Live analysis failed',

        detail:
          error.message,

        timestamp:
          new Date().toISOString()

      });

    }

  }
);


/* =========================================================
   SOCRATES
========================================================= */

app.get(
  '/api/socrates',
  async (req, res) => {

    try {

      const a =
        String(
          req.query.a || ''
        ).trim();


      const b =
        String(
          req.query.b || ''
        ).trim();


      if (
        !/^\d+$/.test(a) ||
        !/^\d+$/.test(b)
      ) {

        return res.status(400).json({

          error:
            'Invalid catalog numbers.'

        });

      }


      const url =
        `${CELESTRAK}/SOCRATES/table-socrates.php?` +
        `CATNR=${a},${b}` +
        `&ORDER=MINRANGE&MAX=25`;


      const response =
        await fetch(
          url,
          {
            headers: {
              'User-Agent':
                'OrbitGuard-Buildathon/2.0'
            }
          }
        );


      const html =
        await response.text();


      if (!response.ok) {

        throw new Error(
          `SOCRATES HTTP ${response.status}: ${html.slice(0, 300)}`
        );

      }


      const clean =
        html
          .replace(
            /<script[\s\S]*?<\/script>/gi,
            ''
          )
          .replace(
            /<style[\s\S]*?<\/style>/gi,
            ''
          );


      const rows =
        [
          ...clean.matchAll(
            /<tr[^>]*>([\s\S]*?)<\/tr>/gi
          )
        ]
          .map(
            match => {

              return [
                ...match[1].matchAll(
                  /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi
                )
              ]
                .map(
                  cell =>
                    cell[1]
                      .replace(
                        /<[^>]+>/g,
                        ' '
                      )
                      .replace(
                        /&nbsp;/g,
                        ' '
                      )
                      .replace(
                        /&amp;/g,
                        '&'
                      )
                      .replace(
                        /&lt;/g,
                        '<'
                      )
                      .replace(
                        /&gt;/g,
                        '>'
                      )
                      .replace(
                        /&quot;/g,
                        '"'
                      )
                      .replace(
                        /\s+/g,
                        ' '
                      )
                      .trim()
                );

            }
          )
          .filter(
            row =>
              row.length
          );


      res.json({

        source: url,

        rows:
          rows.slice(
            0,
            26
          )

      });


    } catch (error) {

      console.error(
        'SOCRATES ERROR:',
        error
      );


      res.status(502).json({

        error:
          'Unable to load SOCRATES data',

        detail:
          error.message

      });

    }

  }
);


/* =========================================================
   Frontend fallback
========================================================= */

app.use(
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );

  }
);


/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      '\n========================================'
    );

    console.log(
      'ORBITGUARD'
    );

    console.log(
      `Running at http://localhost:${PORT}`
    );

    console.log(
      'Live CelesTrak + satellite.js enabled'
    );

    console.log(
      '========================================\n'
    );

  }
);