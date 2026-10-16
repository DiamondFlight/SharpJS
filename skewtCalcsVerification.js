/*
 * Verification notes for src/calc/skewtCalcs.js.
 *
 * "is Correct" means the implementation was checked against its stated/basic
 * mathematical definition. "UNABLE TO TEST" means the behavior is understood,
 * but this review did not have an independent reference implementation or
 * authoritative test data sufficient to certify its full scientific accuracy.
 * Line numbers below refer to src/calc/skewtCalcs.js at the time of review.
 *
 * The repository test suite passes, but its analysis expectations are mostly
 * regression values from this application's prior chart and are not independent
 * scientific validation.
 */

/*
 * ln is Correct
 * DewFromTRh has a coefficient discrepancy.
 *
 * src/calc/skewtCalcs.js:26
 * ```
 * let N = (ln(Rh / 100) + ((17.27 * T) / (237.3 + T))) / 17.27;
 * ```
 *
 * Explanation: the Magnus approximation paired with coefficients 17.27 and
 * 237.7 uses 237.7 in the temperature denominator as well as the final
 * dew-point equation. The 237.3 denominator is inconsistent and introduces a
 * small temperature-dependent error (for example, at 100% RH the result is not
 * exactly the input temperature). This is an approximation, not an exact
 * Clausius-Clapeyron solution.
 *
 * Suggested fix:
 * ```
 * let N = (ln(Rh / 100) + ((17.27 * T) / (237.7 + T))) / 17.27;
 * ```
 * Reference: Bolton (1980), The Computation of Equivalent Potential Temperature,
 * https://doi.org/10.1175/1520-0493(1980)108%3C1046:TCDMAA%3E2.0.CO;2
 */

/* Mag is Correct */
/* GetAngleFromVector is Correct */
/* M2TOKTS is Correct */
/* QCCheck is Correct */
/* VirtTemp is Correct */
/* ConvertToInfo is Correct */
/* GetLerpFactor is Correct */
/* degtoRad is Correct */
/* PolarToCartesianDeg is Correct */
/* RadToDeg is Correct */
/* CartesianToPolarDeg is Correct */
/* Lerp is Correct */
/* GetLayerByHght is Correct but resolution may be inaccurate */
/* ConvertPolartoCart is Correct */
/* GetLayerByPres is Correct but resolution may be inaccurate */
/* MeanWindNW is Correct but resolution may be inaccurate */
/* WindShear is Correct */

/* GetBM is Correct */

/* mean_theta is Correct but resolution may be inaccurate */
/* theta is Correct */
/*
 * mean_mixratio has a difference from a layer-mean mixing-ratio calculation.
 *
 * src/calc/skewtCalcs.js:600-616
 * ```
 * Dwpt += Slice.D;
 * ...
 * Dwpt /= 2;
 * Pres /= 2;
 * Cout /= 2;
 * return mixratio(Pres / Cout, Dwpt / Cout);
 * ```
 *
 * Explanation: the routine averages dew-point temperatures and then converts
 * that mean dew point to mixing ratio. Mixing ratio is nonlinear in dew point;
 * therefore this is not the mean mixing ratio of the layer and can bias the
 * mixed-layer parcel moisture.
 *
 * Suggested fix: calculate mixratio(Slice.P, Slice.D) at each sampled level and
 * average those mixing ratios with pressure-thickness weights (including
 * interpolated layer endpoints).
 */
/* log10 is Correct */
/* temp_at_mixrat is Correct but resolution may be inaccurate */
/* virtemp is Correct */
/* CtoK is Correct */

/*
 * qc has an input-validation defect.
 *
 * src/calc/skewtCalcs.js:682-684
 * ```
 * export function qc(val) {
 *   if (val < -998.0 || val > 2.0E+05) return 0;
 *   return 1;
 * }
 * ```
 *
 * Explanation: NaN passes both comparisons and is reported as valid. This
 * undermines quality checks in thermodynamic calculations that use qc.
 *
 * Suggested fix:
 * ```
 * export function qc(val) {
 *   if (!Number.isFinite(val) || val < -998.0 || val > 2.0E+05) return 0;
 *   return 1;
 * }
 * ```
 */

/* lcltemp is Correct but resolution may be inaccurate */

/*
 * thalvl has an input-validation defect.
 *
 * src/calc/skewtCalcs.js:711
 * ```
 * if (!qc(temp || !qc(thta))) return RMISSD;
 * ```
 *
 * Explanation: this tests a boolean expression rather than independently
 * checking temperature and potential temperature. Invalid thta values may
 * therefore be used in the pressure calculation.
 *
 * Suggested fix:
 * ```
 * if (!qc(temp) || !qc(thta)) return RMISSD;
 * ```
 */

/* FtoC is Correct */
/* drylift is Correct */
/* Wobf is Correct but resolution may be inaccurate */
/* satlift is Correct but resolution may be inaccurate */
/* wetlift is Correct but resolution may be inaccurate */
/* thetae is Correct but resolution may be inaccurate */

/*
 * GetDryLapse has a parcel-temperature interpolation difference.
 *
 * src/calc/skewtCalcs.js:880-882
 * ```
 * for (let i = 0; i < l.length; i++) {
 *   r.push(Lerp(ST.VT, T, (i / (l.length - 1))));
 * }
 * ```
 *
 * Explanation: the dry-adiabatic parcel temperature at a sounding level is
 * selected by its array index, not by that level's pressure or height. If the
 * sounding levels are unevenly spaced, this does not follow the parcel's dry
 * adiabat and can distort parcel temperature, CAPE, CIN, and subsequent
 * characteristic levels.
 *
 * Suggested fix: calculate parcel temperature independently at each layer's
 * pressure from the starting parcel's dry potential temperature (using the
 * dry-adiabatic Poisson relation), or interpolate using the actual pressure or
 * height coordinate rather than the array index.
 */

/* GetMoistLapse is Correct but resolution may be inaccurate */
/* RoundTo is Correct */
/* clamp is Correct */
/* isEmptyObject is Correct */
/* UpdateCSMotStorm is Correct */
/* UpdatePresets is Correct */
/* LiftParcel is UNABLE TO TEST */
/* mean_thetae is Correct but resolution may be inaccurate */
/* wetbulb is Correct but resolution may be inaccurate */
/* GetDCape is UNABLE TO TEST */
/* LapseRateHght is Correct but resolution may be inaccurate */
/* LapseRatePres is Correct but resolution may be inaccurate */
/* EffInflowCalc is UNABLE TO TEST */
/* WindShearAvg is Correct */
/* WindShearFindP is Correct but resolution may be inaccurate */
/* KTSTOM2 is Correct */
/* GetSRH is Correct but resolution may be inaccurate */
/* WindShearFind is Correct but resolution may be inaccurate */
/* GetLayerByTemp is Correct but resolution may be inaccurate */

/* MeanWind is Correct but resolution may be inaccurate */

/* VaporPressure is UNABLE TO TEST */
/* ConvertCartToPolarReal is Correct */
/* getAngleDifference is Correct */
/* mixratio is Correct but resolution may be inaccurate */
/* KTStoMPH is Correct */
/* MPHtoKTS is Correct */

/*
 * calculatePWAT has a layer-truncation and order-dependence defect.
 *
 * src/calc/skewtCalcs.js:2063-2064
 * ```
 * if (p2 < 400 || !qc(p1) || !qc(p2) || !qc(d1) || !qc(d2)) continue;
 * ```
 *
 * Explanation: a complete layer is discarded whenever its second endpoint is
 * below 400 hPa. A layer that crosses 400 hPa is discarded instead of being
 * clipped/interpolated at 400 hPa; reversing the profile order changes which
 * layers pass the test. This can substantially bias precipitable water for
 * coarse or ascending pressure arrays.
 *
 * Suggested fix: normalize each pair to its lower and upper pressure bounds,
 * intersect the layer with the intended integration pressure range, interpolate
 * mixing ratio at the clipped endpoints, and integrate only over that
 * intersection.
 */

/*
 * GetParams has an identified SHIP temperature-factor error; other custom
 * indices in this dispatch function were not independently validated here.
 *
 * src/calc/skewtCalcs.js:2239-2240
 * ```
 * let tmp500 = -Math.min(-5.5, GetLayerByPres(Info.Sounding.Sounding, 500).T);
 * let Ship = (Mucape * LR * tmp500 * MR * BWD) / 42000000;
 * ```
 *
 * Explanation: for a typical 500-hPa temperature below -5.5 C, this expression
 * makes tmp500 equal the full magnitude of that temperature rather than
 * limiting the factor to 5.5 C. For example, T500 = -20 C yields 20 instead of
 * 5.5, inflating SHIP by this factor. The standard SHIP temperature term is
 * capped at 5.5 C.
 *
 * Suggested fix:
 * ```
 * let tmp500 = Math.min(5.5, -GetLayerByPres(Info.Sounding.Sounding, 500).T);
 * ```
 *
 * SHIP overall: UNABLE TO TEST beyond this identified difference; the remaining
 * formula and all other custom parameter branches need independent reference
 * soundings/definitions for full verification.
 */

/* CreateInsetParams is UNABLE TO TEST (requires canvas rendering comparison) */
/* RelHum is Correct but resolution may be inaccurate */
/* mean_rh_in_layer is Correct but resolution may be inaccurate */
/* CToF is Correct */
/* MixRatioColor is Correct */
/* GetSTPColor is Correct */
/* GetSCPColor is Correct */
/* GetCapeColor is Correct */
/* DrawInsetParams is UNABLE TO TEST (requires browser/canvas rendering comparison) */

/*
 * mean_layer_temp has a mismatch in its PWAT branch.
 *
 * src/calc/skewtCalcs.js:3144-3146
 * ```
 * } else if (Stat == "PWAT") {
 *   let snd = Sounding.Sounding;
 *   return calculatePWAT(snd.P, snd.D);
 * }
 * ```
 *
 * Explanation: unlike the Omega, RH, and MixRat branches, this calculates
 * precipitable water over the full sounding rather than the layer bounded by
 * Temp1 and Temp2. The caller labels the result as DGZ precipitable water, so
 * the displayed layer value is not actually restricted to the DGZ.
 *
 * Suggested fix: convert Temp1 and Temp2 to bounding pressure levels, clip
 * sounding segments to those bounds, and integrate mixing ratio only through
 * that layer.
 */

/* relh is Correct */
/* mean_relh is Correct but resolution may be inaccurate */

/*
 * calculateHeightsAboveGround has a reference-level/sign defect for the
 * conventional surface-to-aloft (descending-pressure) input order.
 *
 * src/calc/skewtCalcs.js:3212-3225
 * ```
 * const heightDifference =
 *   ((R * meanTemp) / g) *
 *   Math.log(pressureLevels[i] / pressureLevels[i - 1]);
 * heightsFromTop.push(heightsFromTop[i - 1] + heightDifference);
 * ...
 * const surfaceHeight = heightsFromTop[n - 1];
 * for (let i = 0; i < n; i++) {
 *   heights.push(surfaceHeight - heightsFromTop[i]);
 * }
 * ```
 *
 * Explanation: for descending pressures ordered from the surface upward,
 * log(p[i]/p[i-1]) is negative; the final transformation consequently places
 * the top level at zero and the surface at a positive height. These are heights
 * relative to the profile top, not heights above ground as the function name
 * promises.
 *
 * Suggested fix: for descending pressure inputs, start with heights[0] = 0
 * and accumulate (R * meanTemp / g) * log(p[i-1] / p[i]) upward. Validate that
 * pressure and temperature arrays are same-length, finite, and monotonically
 * ordered (or explicitly normalize their order).
 *
 * Reference: AMS Glossary of Meteorology, "hypsometric equation",
 * https://glossary.ametsoc.org/wiki/hypsometric_equation/
 */
