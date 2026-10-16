/*
 * Verification notes for src/calc/ecape.js and src/calc/ecapeCalc.js.
 *
 * Compared with Amelia Urquhart's ecape-parcel-py implementation, version
 * 1.2.2, commit edddf4f68fe70cc8d81f309eb15d94b0f4fc16e1:
 * https://github.com/a-urq/ecape-parcel-py/tree/edddf4f68fe70cc8d81f309eb15d94b0f4fc16e1
 *
 * Line numbers below refer to the local files at the time of review. The
 * Python implementation is a reference for this comparison, not an
 * independent validation of the underlying scientific model.
 */

/* density_temperature matches the Python formula for scalar inputs. */
/* USALR matches the Python unsaturated adiabatic lapse-rate formula. */

/*
 * SALR has a material saturated-lapse-rate term discrepancy.
 *
 * src/calc/ecape.js:78, 115
 * ```
 * qt_e = (qt_e !== null ? qt_e : -eRate * (qt_prcl - qv_env) - prate * (qt_prcl - qv_parcel));
 * ...
 * L_s * (qEntrain + qv_parcel/(1 - qt_prcl) * qEntrain)
 * ```
 *
 * Explanation: the corresponding Python equation uses the total-water
 * entrainment tendency (`qt_entrainment`) in the second term, not the vapor
 * tendency (`qv_entrainment`) twice. The locally calculated `qt_e` is never
 * used. Also, when `qt_e` is omitted its value is `undefined`, and the strict
 * null check leaves it undefined instead of calculating the default tendency.
 * This changes the saturated parcel temperature tendency and can affect the
 * ECAPE parcel wherever this branch is used.
 *
 * Suggested fix:
 * ```
 * qt_e = (qt_e == null ? -eRate * (qt_prcl - qv_env) - prate * (qt_prcl - qv_parcel) : qt_e);
 * ...
 * L_s * (qEntrain + qv_parcel / (1 - qt_prcl) * qt_e)
 * ```
 *
 * Reference: `src/ecape_parcel/calc.py`, `saturated_adiabatic_lapse_rate`,
 * lines 814-852 in the cited commit.
 */

/*
 * r_sat has an incorrect latent-heat constant for ice saturation.
 *
 * src/calc/ecapeCalc.js:523
 * ```
 * t2: (Constants.L_v_trip - Constants.T_trip * (Constants.c_pv - Constants.c_pi)) / Constants.R_v,
 * ```
 *
 * Explanation: the Python ice branch uses the latent heat of sublimation
 * (`xls`, 2,834,000 J/kg). The local constant is the latent heat of
 * vaporization (`L_v_trip`, 2,501,000 J/kg). Since this branch computes ice
 * saturation vapor pressure, the difference produces an erroneous ice
 * saturation mixing ratio and propagates into mixed-phase lapse-rate
 * calculations.
 *
 * Suggested fix:
 * ```
 * t2: (Constants.xls - Constants.T_trip * (Constants.c_pv - Constants.c_pi)) / Constants.R_v,
 * ```
 *
 * Reference: `src/ecape_parcel/ecape_calc.py`, `r_sat`, ice branches, lines
 * 346-353 in the cited commit.
 */

/*
 * compute_NCAPE does not initialize its vertical grid at the sounding surface.
 *
 * src/calc/ecapeCalc.js:598-600
 * ```
 * for (let i = 0; i < EndSlice.H; i += 100) {
 *   const FSlice = GetLayerByHght(Snding, i, false);
 *   const RT = FSlice.T + 273.15;
 * ```
 *
 * Explanation: the local loop assumes the profile starts at 0 m MSL, whereas
 * the Python calculation uses the supplied `z0` profile, whose first value is
 * the actual lowest sounding height. For a sounding with a 362 m surface,
 * `GetLayerByHght(Snding, 0, false)` is below the profile and returns false;
 * reading `FSlice.T` then fails. Even when the lookup happens to be valid,
 * indices based on `LFC / 100` and `EL / 100` only correspond to this
 * zero-origin 100-m grid.
 *
 * Suggested fix: construct sample heights from the actual surface height
 * (or use the supplied `z0` grid), and map LFC/EL to the nearest sampled
 * heights as the Python implementation does.
 *
 * Reference: `src/ecape_parcel/ecape_calc.py`, `compute_NCAPE`, lines 362-401
 * in the cited commit.
 */

/*
 * compute_NCAPE omits the last layer in each cumulative mean-MSE calculation.
 *
 * src/calc/ecapeCalc.js:623-631
 * ```
 * for (let x = 0; x < iz - 1; x++) {
 *   const pp = (MSE0[x] + MSE0[x + 1]) * 100;
 *   ...
 * }
 * MSE0_bar[iz] = 0.5 * T / (iz * 100);
 * ```
 *
 * Explanation: for a 100-m grid, the Python calculation sums intervals
 * `x = 0` through `iz - 1` to obtain the mean from the base to level `iz`.
 * The local loop stops before interval `iz - 1`; at `iz === 1` it sums no
 * intervals and sets the mean MSE to zero. This biases the MSE difference
 * used by the NCAPE integral and therefore the ECAPE calculation.
 *
 * Suggested fix: include all intervals up to the target level (`x < iz`),
 * using the actual height increments in the trapezoidal integral.
 *
 * Reference: `src/ecape_parcel/ecape_calc.py`, `compute_NCAPE`, lines 392-394
 * in the cited commit.
 */

/*
 * calc_psi is missing a factor of four in the denominator.
 *
 * src/calc/ecapeCalc.js:726
 * ```
 * return (ksq * alpha ** 2 * Math.PI ** 2 * l_mix) /
 *   (pr * sigma ** 2 * el);
 * ```
 *
 * Explanation: the Python implementation divides by
 * `4 * Pr * sigma^2 * el_z`. The local value of psi is therefore four times
 * larger than the reference value for the same equilibrium-level height.
 * Since psi is an input to the ECAPE equation, this materially changes ECAPE.
 *
 * Suggested fix: include the missing factor:
 * ```
 * return (ksq * alpha ** 2 * Math.PI ** 2 * l_mix) /
 *   (4 * pr * sigma ** 2 * el);
 * ```
 *
 * Reference: `src/ecape_parcel/ecape_calc.py`, `calc_psi`, lines 443-466 in
 * the cited commit.
 */

/*
 * calc_sr_wind does not honor the full inflow-layer bounds.
 *
 * src/calc/ecapeCalc.js:693-707
 * ```
 * export function calc_sr_wind(pres, uwind, vwind, hght, ifb, ift, CSMot, V) {
 *   ...
 *   if (hghtAGL[i] <= ift) {
 *     srwind += (hghtAGL[i + 1] - hghtAGL[i]) / 1000 * speed;
 *   }
 * }
 * ```
 *
 * Explanation: `ifb` is never used, so winds below a nonzero inflow base are
 * included. The result is divided by a fixed 1000 m rather than the requested
 * layer depth, and a segment crossing `ift` is included in full. The Python
 * reference selects only wind levels within both bounds and averages their
 * storm-relative speeds. The current default 0-1000 m call avoids the lower
 * bound discrepancy, but custom layers and coarse layers can yield a
 * materially different storm-relative wind and ECAPE.
 *
 * Suggested fix: restrict or interpolate samples to both `ifb` and `ift`,
 * then compute a normalized mean over that interval; if matching the Python
 * method exactly is required, average the speeds at levels selected inside
 * the inclusive bounds.
 *
 * Reference: `src/ecape_parcel/ecape_calc.py`, `calc_sr_wind`, lines 147-190
 * in the cited commit.
 */

/*
 * linear_interp fails to clamp values above the final input coordinate.
 *
 * src/calc/ecapeCalc.js:332-336
 * ```
 * } else if (input >= input_arr[-1]) {
 *   return LastItem(output_arr);
 * }
 * ```
 *
 * Explanation: negative indexing is not supported for ordinary JavaScript
 * arrays, so `input_arr[-1]` is undefined and this upper-bound check never
 * succeeds. Unlike the Python reference, an input above the last height can
 * fall through and return null instead of the final environmental value.
 * `ecape_parcel` uses this helper while stepping the parcel up to the sounding
 * top, so a final step beyond the profile can contaminate the returned path.
 *
 * Suggested fix:
 * ```
 * } else if (input >= LastItem(input_arr)) {
 *   return LastItem(output_arr);
 * }
 *
 * Reference: `src/ecape_parcel/calc.py`, `linear_interp`, lines 498-537 in
 * the cited commit.
 */

/* calc_ecape_a matches the Python algebraic ECAPE equation. */
/* entrainment_rate matches the Python entrainment-rate formula. */
/* density_temperature matches for scalar inputs; null-array behavior differs. */
