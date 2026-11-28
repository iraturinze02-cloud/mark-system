
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

/* =========================================================
   FILA GRADES SYSTEM
   SECTOR ADMIN — TESTS & REPORTS API

   GET /api/sector-tests-reports?action=years
   GET /api/sector-tests-reports?action=tests&academic_year=2026-2027
   GET /api/sector-tests-reports?action=report&academic_year=2026-2027
   GET /api/sector-tests-reports?action=report&academic_year=2026-2027&test_id=123

   REPORTING RULES:
   - Academic-year report combines all available results
     across tests and terms in the selected academic year.
   - Individual-test report combines the subjects in that test.
   - Overall learner percentages are weighted:
       total marks obtained / total possible marks * 100
   - Each learner is counted once in overall distributions.
   - Subject performance remains subject-result based.
   - Teacher assignments support exact-period assignments
     and legacy assignments with NULL period fields.
   - Subclass-specific teacher assignments are respected.
   - Uses latest mark for each test/student/class/subject.
   - No database migration required.
========================================================= */


/* =========================================================
   GENERAL HELPERS
========================================================= */

function validId(value) {
    const n = Number(value);

    return Number.isSafeInteger(n) && n > 0
        ? n
        : null;
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function round(value) {
    return Math.round(
        (num(value) + Number.EPSILON) * 100
    ) / 100;
}

function percentage(value, total) {
    return total > 0
        ? round((value / total) * 100)
        : 0;
}

function gradeCategory(value) {
    if (value >= 80) return "A";
    if (value >= 75) return "B";
    if (value >= 70) return "C";
    if (value >= 65) return "D";
    if (value >= 60) return "E";
    if (value >= 50) return "S";
    return "F";
}

function emptyCounters() {
    return {
        candidates: 0,
        recorded: 0,
        missing: 0,
        passed: 0,
        failed: 0,
        score_sum: 0,
        percentage_sum: 0
    };
}

/*
 * Result-based counters.
 *
 * Used for subject performance, where each row represents
 * one learner's result in one subject.
 */
function addResult(target, row) {
    target.candidates++;

    if (
        row.percentage === null ||
        row.percentage === undefined
    ) {
        target.missing++;
        return;
    }

    target.recorded++;

    target.score_sum += num(row.score);
    target.percentage_sum += num(row.percentage);

    if (num(row.percentage) >= 50) {
        target.passed++;
    } else {
        target.failed++;
    }
}

function finishCounters(target) {
    return {
        candidates: target.candidates,
        recorded: target.recorded,
        missing: target.missing,
        passed: target.passed,
        failed: target.failed,

        average: target.recorded > 0
            ? round(target.score_sum / target.recorded)
            : 0,

        average_percentage: target.recorded > 0
            ? round(target.percentage_sum / target.recorded)
            : 0,

        pass_rate: percentage(
            target.passed,
            target.recorded
        ),

        recording_rate: percentage(
            target.recorded,
            target.candidates
        )
    };
}


/* =========================================================
   LEARNER-BASED AGGREGATION

   These functions ensure that one learner is counted once
   in the overall, school, gender, grade and band reports.

   The learner's percentage is calculated from the sum of
   their recorded marks and the corresponding total marks.

   Example:
       Subject 1: 70 / 100
       Subject 2: 40 / 50
       Subject 3: 30 / 50

       Overall = 140 / 200 * 100 = 70%

   It is NOT calculated by counting the three subject
   percentages as three separate learners.
========================================================= */

function createLearnerEntry(metadata) {
    return {
        ...metadata,

        opportunities: 0,
        recorded_subjects: 0,

        score_sum: 0,
        maximum_sum: 0
    };
}

function addLearnerResult(target, row) {
    target.opportunities++;

    const score =
        row.score === null || row.score === undefined
            ? null
            : num(row.score);

    const maximum = num(row.total_marks);

    if (
        score === null ||
        maximum <= 0
    ) {
        return;
    }

    target.recorded_subjects++;

    target.score_sum += score;
    target.maximum_sum += maximum;
}

function getLearnerPercentage(learner) {
    if (
        !learner ||
        learner.recorded_subjects <= 0 ||
        learner.maximum_sum <= 0
    ) {
        return null;
    }

    return round(
        (learner.score_sum / learner.maximum_sum) * 100
    );
}

function finishLearnerMap(map) {
    const learners = Array.from(map.values());

    const result = {
        candidates: learners.length,
        recorded: 0,
        missing: 0,
        passed: 0,
        failed: 0,
        average: 0,
        average_percentage: 0,
        pass_rate: 0,
        recording_rate: 0
    };

    let percentageSum = 0;

    for (const learner of learners) {
        const learnerPercentage =
            getLearnerPercentage(learner);

        if (learnerPercentage === null) {
            result.missing++;
            continue;
        }

        result.recorded++;
        percentageSum += learnerPercentage;

        if (learnerPercentage >= 50) {
            result.passed++;
        } else {
            result.failed++;
        }
    }

    result.average_percentage = result.recorded > 0
        ? round(percentageSum / result.recorded)
        : 0;

    /*
     * For learner-based reports, average is the average
     * of each learner's overall percentage.
     */
    result.average = result.average_percentage;

    result.pass_rate = percentage(
        result.passed,
        result.recorded
    );

    result.recording_rate = percentage(
        result.recorded,
        result.candidates
    );

    return result;
}

function createBandCounters() {
    return [
        { label: "0–9.99", min: 0, max: 10, count: 0 },
        { label: "10–19.99", min: 10, max: 20, count: 0 },
        { label: "20–29.99", min: 20, max: 30, count: 0 },
        { label: "30–39.99", min: 30, max: 40, count: 0 },
        { label: "40–49.99", min: 40, max: 50, count: 0 },
        { label: "50–59.99", min: 50, max: 60, count: 0 },
        { label: "60–69.99", min: 60, max: 70, count: 0 },
        { label: "70–79.99", min: 70, max: 80, count: 0 },
        { label: "80–89.99", min: 80, max: 90, count: 0 },
        { label: "90–100", min: 90, max: 101, count: 0 }
    ];
}

function getBand(value) {
    const score = num(value);

    if (score >= 100) return 9;

    return Math.max(
        0,
        Math.min(9, Math.floor(score / 10))
    );
}

function createSchoolEntry(row) {
    return {
        school_id: String(row.school_id),
        school: row.school_name,
        learners: new Map()
    };
}

function createSubjectEntry(row) {
    return {
        subject_id: String(row.subject_id),
        subject: row.subject_name,
        subject_code: row.subject_code,
        ...emptyCounters()
    };
}

function createLearnerKey(row) {
    return [
        String(row.school_id),
        String(row.student_id)
    ].join("_");
}


/* =========================================================
   SECTOR ACCESS
========================================================= */

async function getSectorTest(client, testId, sectorId) {
    const result = await client.query(
        `
        SELECT
            t.id,
            t.test_name,
            t.status,
            t.created_at,
            t.created_by

        FROM tests t

        WHERE t.id = $1

          AND (
                t.sector_id = $2

                OR EXISTS (
                    SELECT 1
                    FROM test_schools ts
                    INNER JOIN schools s
                        ON s.id = ts.school_id
                    WHERE ts.test_id = t.id
                      AND s.sector_id = $2
                )

                OR (
                    t.school_id IS NOT NULL
                    AND EXISTS (
                        SELECT 1
                        FROM schools s
                        WHERE s.id = t.school_id
                          AND s.sector_id = $2
                    )
                )
          )

        LIMIT 1
        `,
        [testId, sectorId]
    );

    return result.rows[0] || null;
}


/* =========================================================
   AVAILABLE ACADEMIC YEARS
========================================================= */

async function getAcademicYears(client, sectorId) {
    const result = await client.query(
        `
        SELECT
            ay.year_name,

            MIN(ay.start_date) AS start_date,
            MAX(ay.end_date) AS end_date,

            COUNT(DISTINCT ts.test_id) AS total_tests,
            COUNT(DISTINCT ts.school_id) AS total_schools

        FROM test_schools ts

        INNER JOIN schools s
            ON s.id = ts.school_id
           AND s.sector_id = $1

        INNER JOIN academic_years ay
            ON ay.id = ts.academic_year_id
           AND ay.school_id = ts.school_id

        GROUP BY ay.year_name

        ORDER BY MAX(ay.start_date) DESC, ay.year_name DESC
        `,
        [sectorId]
    );

    return result.rows.map(row => ({
        academic_year: row.year_name,
        start_date: row.start_date,
        end_date: row.end_date,
        total_tests: num(row.total_tests),
        total_schools: num(row.total_schools)
    }));
}


/* =========================================================
   TESTS FOR SELECTED ACADEMIC YEAR
========================================================= */

async function getAcademicYearTests(
    client,
    sectorId,
    academicYear
) {
    const result = await client.query(
        `
        SELECT
            t.id,
            t.test_name AS name,
            t.status,
            t.created_at,

            COUNT(DISTINCT ts.school_id) AS total_schools

        FROM tests t

        INNER JOIN test_schools ts
            ON ts.test_id = t.id

        INNER JOIN schools s
            ON s.id = ts.school_id
           AND s.sector_id = $1

        INNER JOIN academic_years ay
            ON ay.id = ts.academic_year_id
           AND ay.school_id = ts.school_id

        WHERE ay.year_name = $2

        GROUP BY
            t.id,
            t.test_name,
            t.status,
            t.created_at

        ORDER BY t.created_at DESC, t.id DESC
        `,
        [sectorId, academicYear]
    );

    return result.rows.map(row => ({
        id: String(row.id),
        name: row.name,
        status: row.status,
        created_at: row.created_at,
        total_schools: num(row.total_schools)
    }));
}


/* =========================================================
   LOAD STUDENT RESULTS

   One row represents one learner's result opportunity
   in one test, school, class and subject.

   The active enrollment must match the school, class,
   academic year and term associated with the test.

   Latest mark is selected to avoid counting old versions
   of a mark multiple times.
========================================================= */

async function getResultRows(
    client,
    sectorId,
    academicYear,
    testId
) {
    const parameters = [
        sectorId,
        academicYear
    ];

    let testCondition = "";

    if (testId) {
        parameters.push(testId);
        testCondition = `AND t.id = $${parameters.length}`;
    }

    const result = await client.query(
        `
        WITH active_enrollments AS (
            SELECT DISTINCT ON (
                se.student_id,
                se.school_id,
                se.class_id,
                se.academic_year_id,
                se.term_id
            )
                se.student_id,
                se.school_id,
                se.class_id,
                se.academic_year_id,
                se.term_id,
                se.subclass_id

            FROM student_enrollments se

            WHERE LOWER(TRIM(se.status)) = 'active'

            ORDER BY
                se.student_id,
                se.school_id,
                se.class_id,
                se.academic_year_id,
                se.term_id,
                se.updated_at DESC NULLS LAST,
                se.id DESC
        )

        SELECT
            t.id AS test_id,
            t.test_name,
            t.status AS test_status,
            t.created_at AS test_created_at,

            ts.academic_year_id,
            ts.term_id,

            ay.year_name,
            tm.term_number,
            tm.term_name,

            s.id AS school_id,
            s.school_name,

            c.id AS class_id,
            c.class_name,
            c.level_id,

            sub.id AS subject_id,
            sub.subject_name,
            sub.subject_code,

            test_subject.total_marks,

            st.id AS student_id,
            st.full_name AS student_name,
            st.student_code,
            st.gender,

            latest_mark.score

        FROM tests t

        INNER JOIN test_schools ts
            ON ts.test_id = t.id

        INNER JOIN schools s
            ON s.id = ts.school_id
           AND s.sector_id = $1

        INNER JOIN academic_years ay
            ON ay.id = ts.academic_year_id
           AND ay.school_id = ts.school_id
           AND ay.year_name = $2

        INNER JOIN terms tm
            ON tm.id = ts.term_id
           AND tm.academic_year_id = ts.academic_year_id
           AND tm.school_id = ts.school_id

        INNER JOIN test_classes tc
            ON tc.test_id = t.id
           AND tc.school_id = ts.school_id

        INNER JOIN classes c
            ON c.id = tc.class_id

        INNER JOIN test_subjects test_subject
            ON test_subject.test_id = t.id

        INNER JOIN subjects sub
            ON sub.id = test_subject.subject_id

        LEFT JOIN active_enrollments enrollment
            ON enrollment.school_id = ts.school_id
           AND enrollment.class_id = tc.class_id
           AND enrollment.academic_year_id = ts.academic_year_id
           AND enrollment.term_id = ts.term_id

        LEFT JOIN students st
            ON st.id = enrollment.student_id
           AND st.school_id = ts.school_id
           AND LOWER(TRIM(st.status)) = 'active'

        LEFT JOIN LATERAL (
            SELECT mk.score

            FROM marks mk

            WHERE mk.test_id = t.id
              AND mk.student_id = st.id
              AND mk.class_id = tc.class_id
              AND mk.subject_id = sub.id

            ORDER BY
                mk.updated_at DESC NULLS LAST,
                mk.id DESC

            LIMIT 1
        ) latest_mark ON TRUE

        WHERE 1 = 1
          ${testCondition}

        ORDER BY
            t.created_at DESC,
            s.school_name,
            c.class_name,
            sub.subject_name,
            st.full_name
        `,
        parameters
    );

    return result.rows;
}


/* =========================================================
   LOAD TEACHER RESULTS

   Assignment matching:
   - Exact academic year and term assignments are preferred.
   - Legacy assignments with NULL year/term are accepted.
   - Assignments belonging to another year or term are not
     used.
   - Subclass-specific assignments only match learners
     belonging to that subclass.
   - One matching assignment is selected per learner,
     test, class and subject to avoid duplicate counting.
========================================================= */

async function getTeacherRows(
    client,
    sectorId,
    academicYear,
    testId
) {
    const parameters = [
        sectorId,
        academicYear
    ];

    let testCondition = "";

    if (testId) {
        parameters.push(testId);
        testCondition = `AND t.id = $${parameters.length}`;
    }

    const result = await client.query(
        `
        WITH active_enrollments AS (
            SELECT DISTINCT ON (
                se.student_id,
                se.school_id,
                se.class_id,
                se.academic_year_id,
                se.term_id
            )
                se.student_id,
                se.school_id,
                se.class_id,
                se.academic_year_id,
                se.term_id,
                se.subclass_id

            FROM student_enrollments se

            WHERE LOWER(TRIM(se.status)) = 'active'

            ORDER BY
                se.student_id,
                se.school_id,
                se.class_id,
                se.academic_year_id,
                se.term_id,
                se.updated_at DESC NULLS LAST,
                se.id DESC
        )

        SELECT
            t.id AS test_id,

            assignment.teacher_id,
            assignment.teacher_name,

            s.id AS school_id,
            s.school_name,

            sub.id AS subject_id,
            sub.subject_name,
            sub.subject_code,

            c.id AS class_id,
            c.class_name,

            ts.academic_year_id,
            ts.term_id,

            test_subject.total_marks,

            st.id AS student_id,
            st.full_name AS student_name,

            latest_mark.score

        FROM tests t

        INNER JOIN test_schools ts
            ON ts.test_id = t.id

        INNER JOIN schools s
            ON s.id = ts.school_id
           AND s.sector_id = $1

        INNER JOIN academic_years ay
            ON ay.id = ts.academic_year_id
           AND ay.school_id = ts.school_id
           AND ay.year_name = $2

        INNER JOIN test_classes tc
            ON tc.test_id = t.id
           AND tc.school_id = ts.school_id

        INNER JOIN classes c
            ON c.id = tc.class_id

        INNER JOIN test_subjects test_subject
            ON test_subject.test_id = t.id

        INNER JOIN subjects sub
            ON sub.id = test_subject.subject_id

        LEFT JOIN active_enrollments enrollment
            ON enrollment.school_id = ts.school_id
           AND enrollment.class_id = tc.class_id
           AND enrollment.academic_year_id = ts.academic_year_id
           AND enrollment.term_id = ts.term_id

        INNER JOIN students st
            ON st.id = enrollment.student_id
           AND st.school_id = ts.school_id
           AND LOWER(TRIM(st.status)) = 'active'

        INNER JOIN LATERAL (
            SELECT
                ta.teacher_id,
                u.full_name AS teacher_name

            FROM teacher_assignments ta

            INNER JOIN teachers teacher
                ON teacher.id = ta.teacher_id
               AND teacher.school_id = ta.school_id

            INNER JOIN users u
                ON u.id = teacher.user_id
               AND u.school_id = teacher.school_id
               AND u.role = 'teacher'

            WHERE ta.school_id = ts.school_id
              AND ta.class_id = tc.class_id
              AND ta.subject_id = sub.id

              AND (
                    ta.academic_year_id = ts.academic_year_id
                    OR ta.academic_year_id IS NULL
              )

              AND (
                    ta.term_id = ts.term_id
                    OR ta.term_id IS NULL
              )

              AND (
                    ta.subclass_id IS NULL
                    OR ta.subclass_id = enrollment.subclass_id
              )

            ORDER BY
                CASE
                    WHEN ta.academic_year_id = ts.academic_year_id
                     AND ta.term_id = ts.term_id
                    THEN 1

                    WHEN ta.academic_year_id = ts.academic_year_id
                    THEN 2

                    WHEN ta.term_id = ts.term_id
                    THEN 3

                    ELSE 4
                END,

                CASE
                    WHEN ta.subclass_id = enrollment.subclass_id
                     AND ta.subclass_id IS NOT NULL
                    THEN 1
                    ELSE 2
                END,

                ta.id DESC

            LIMIT 1
        ) assignment ON TRUE

        LEFT JOIN LATERAL (
            SELECT mk.score

            FROM marks mk

            WHERE mk.test_id = t.id
              AND mk.student_id = st.id
              AND mk.class_id = tc.class_id
              AND mk.subject_id = sub.id

            ORDER BY
                mk.updated_at DESC NULLS LAST,
                mk.id DESC

            LIMIT 1
        ) latest_mark ON TRUE

        WHERE 1 = 1
          ${testCondition}

        ORDER BY
            assignment.teacher_name,
            s.school_name,
            sub.subject_name,
            c.class_name,
            st.full_name
        `,
        parameters
    );

    return result.rows;
}


/* =========================================================
   BUILD REPORTS
========================================================= */

function buildReports(
    rows,
    teacherRows,
    tests,
    academicYear
) {
    /*
     * Overall learner map:
     * one entry per learner per school across the selected
     * academic year, or across the selected individual test.
     */
    const overallLearners = new Map();

    /*
     * School learner maps:
     * one entry per learner per school.
     */
    const schoolMap = new Map();

    /*
     * Subject counters remain based on learner-subject
     * result opportunities.
     */
    const subjectMap = new Map();

    /*
     * Gender learner maps:
     * one entry per learner.
     */
    const genderLearnerMaps = new Map();

    /*
     * Test learner maps:
     * one entry per learner per test.
     */
    const testMap = new Map();

    /*
     * Performance bands and grades count learners,
     * not individual subject results.
     */
    const bands = createBandCounters();

    const gradeMap = {
        A: 0,
        B: 0,
        C: 0,
        D: 0,
        E: 0,
        S: 0,
        F: 0
    };

    /*
     * Process result rows.
     */
    for (const row of rows) {
        const testId = String(row.test_id);
        const schoolId = String(row.school_id);

        /*
         * Initialize test information even if the test
         * has no active learners.
         */
        if (!testMap.has(testId)) {
            testMap.set(testId, {
                id: testId,
                name: row.test_name,
                status: row.test_status,
                created_at: row.test_created_at,
                terms: new Set(),
                schools: new Set(),
                learners: new Map()
            });
        }

        const testEntry = testMap.get(testId);

        testEntry.terms.add(num(row.term_number));
        testEntry.schools.add(schoolId);

        /*
         * Initialize school.
         */
        if (!schoolMap.has(schoolId)) {
            schoolMap.set(
                schoolId,
                {
                    school_id: schoolId,
                    school: row.school_name,
                    learners: new Map()
                }
            );
        }

        /*
         * Initialize subject.
         */
        if (!subjectMap.has(String(row.subject_id))) {
            subjectMap.set(
                String(row.subject_id),
                createSubjectEntry(row)
            );
        }

        /*
         * Ignore rows without an actual learner.
         */
        if (!row.student_id) {
            continue;
        }

        const score =
            row.score === null || row.score === undefined
                ? null
                : num(row.score);

        const maximum = num(row.total_marks);

        const resultPercentage =
            score !== null && maximum > 0
                ? round((score / maximum) * 100)
                : null;

        const resultRow = {
            score,
            percentage: resultPercentage
        };

        const learnerKey = createLearnerKey(row);

        const studentId = String(row.student_id);

        /*
         * OVERALL LEARNER
         */
        if (!overallLearners.has(learnerKey)) {
            overallLearners.set(
                learnerKey,
                createLearnerEntry({
                    student_id: studentId,
                    school_id: schoolId,
                    student: row.student_name,
                    gender: row.gender
                })
            );
        }

        addLearnerResult(
            overallLearners.get(learnerKey),
            row
        );

        /*
         * SCHOOL LEARNER
         */
        const schoolLearners =
            schoolMap.get(schoolId).learners;

        if (!schoolLearners.has(studentId)) {
            schoolLearners.set(
                studentId,
                createLearnerEntry({
                    student_id: studentId,
                    school_id: schoolId,
                    student: row.student_name,
                    gender: row.gender
                })
            );
        }

        addLearnerResult(
            schoolLearners.get(studentId),
            row
        );

        /*
         * SUBJECT RESULT
         *
         * Subject performance is intentionally calculated
         * from individual learner-subject results.
         */
        addResult(
            subjectMap.get(String(row.subject_id)),
            resultRow
        );

        /*
         * TEST LEARNER
         */
        const testLearnerKey = [
            schoolId,
            studentId
        ].join("_");

        if (!testEntry.learners.has(testLearnerKey)) {
            testEntry.learners.set(
                testLearnerKey,
                createLearnerEntry({
                    student_id: studentId,
                    school_id: schoolId,
                    student: row.student_name,
                    gender: row.gender
                })
            );
        }

        addLearnerResult(
            testEntry.learners.get(testLearnerKey),
            row
        );

        /*
         * GENDER LEARNER
         */
        const gender = String(row.gender || "")
            .trim()
            .toLowerCase();

        let genderLabel = "Not specified";

        if (gender === "male" || gender === "m") {
            genderLabel = "Male";
        } else if (gender === "female" || gender === "f") {
            genderLabel = "Female";
        }

        if (!genderLearnerMaps.has(genderLabel)) {
            genderLearnerMaps.set(
                genderLabel,
                new Map()
            );
        }

        const genderLearners =
            genderLearnerMaps.get(genderLabel);

        if (!genderLearners.has(learnerKey)) {
            genderLearners.set(
                learnerKey,
                createLearnerEntry({
                    student_id: studentId,
                    school_id: schoolId,
                    student: row.student_name,
                    gender: genderLabel
                })
            );
        }

        addLearnerResult(
            genderLearners.get(learnerKey),
            row
        );
    }


    /* =====================================================
       OVERALL LEARNER SUMMARY
    ===================================================== */

    const overall = finishLearnerMap(overallLearners);


    /* =====================================================
       PERFORMANCE DISTRIBUTION

       Every learner is counted once using their overall
       percentage across the selected reporting scope.
    ===================================================== */

    const schoolBandMap = new Map();

    for (const [schoolId, school] of schoolMap.entries()) {
        schoolBandMap.set(schoolId, {
            school_id: school.school_id,
            school: school.school,
            bands: createBandCounters()
        });
    }

    for (const learner of overallLearners.values()) {
        const learnerPercentage =
            getLearnerPercentage(learner);

        if (learnerPercentage === null) {
            continue;
        }

        const bandIndex = getBand(learnerPercentage);

        bands[bandIndex].count++;

        const schoolId = String(learner.school_id);

        if (schoolBandMap.has(schoolId)) {
            schoolBandMap.get(schoolId)
                .bands[bandIndex]
                .count++;
        }

        const grade = gradeCategory(learnerPercentage);

        gradeMap[grade]++;
    }


    /* =====================================================
       SCHOOL RANKING
    ===================================================== */

    const schools = Array.from(schoolMap.values())
        .map(item => ({
            school_id: item.school_id,
            school: item.school,
            ...finishLearnerMap(item.learners)
        }))
        .sort((a, b) =>
            b.pass_rate - a.pass_rate ||
            b.passed - a.passed ||
            b.average_percentage - a.average_percentage ||
            a.school.localeCompare(b.school)
        )
        .map((item, index) => ({
            rank: index + 1,
            ...item
        }));


    /* =====================================================
       SUBJECT PERFORMANCE
    ===================================================== */

    const subjects = Array.from(subjectMap.values())
        .map(item => ({
            subject_id: item.subject_id,
            subject: item.subject,
            subject_code: item.subject_code,
            ...finishCounters(item)
        }))
        .sort((a, b) =>
            b.pass_rate - a.pass_rate ||
            b.average_percentage - a.average_percentage
        );


    /* =====================================================
       GENDER ANALYSIS
    ===================================================== */

    const genders = Array.from(genderLearnerMaps.entries())
        .map(([gender, learners]) => ({
            gender,
            ...finishLearnerMap(learners)
        }))
        .sort((a, b) =>
            a.gender.localeCompare(b.gender)
        );


    /* =====================================================
       SCHOOL PERFORMANCE BY SCORE BAND
    ===================================================== */

    const schoolBands = Array.from(schoolBandMap.values())
        .map(school => ({
            school_id: school.school_id,
            school: school.school,
            bands: school.bands.map(band => ({
                label: band.label,
                count: band.count
            }))
        }));

    const bandWinners = bands.map(band => {
        const schoolCounts = schoolBands.map(school => ({
            school_id: school.school_id,
            school: school.school,
            count: school.bands.find(
                item => item.label === band.label
            )?.count || 0
        })).sort((a, b) =>
            b.count - a.count ||
            a.school.localeCompare(b.school)
        );

        return {
            label: band.label,
            count: band.count,
            leading_school: schoolCounts[0]?.school || null,
            leading_school_count: schoolCounts[0]?.count || 0,
            schools: schoolCounts
        };
    });


    /* =====================================================
       GRADE DISTRIBUTION

       Counts learners, not subject results.
    ===================================================== */

    const grades = Object.entries(gradeMap).map(
        ([grade, count]) => ({
            grade,
            count,
            percentage: percentage(
                count,
                overall.recorded
            )
        })
    );


    /* =====================================================
       TEST PERFORMANCE / YEAR PROGRESS

       Each learner is counted once per test, using the
       combined percentage across that test's subjects.
    ===================================================== */

    const testPerformance = Array.from(testMap.values())
        .map(item => ({
            id: item.id,
            name: item.name,
            status: item.status,
            created_at: item.created_at,
            terms: Array.from(item.terms).sort((a, b) => a - b),
            total_schools: item.schools.size,
            ...finishLearnerMap(item.learners)
        }))
        .sort((a, b) =>
            new Date(a.created_at) - new Date(b.created_at)
        );


    /* =====================================================
       TEACHER PERFORMANCE

       Teacher subject performance combines the learner's
       recorded marks for that subject across the selected
       reporting scope.

       Overall teacher performance combines all assigned
       subject results for each learner.

       Each learner is counted once per teacher and school.
    ===================================================== */

    const teacherSubjectLearners = new Map();
    const teacherOverallLearners = new Map();

    const teacherSubjectMetadata = new Map();
    const teacherOverallMetadata = new Map();

    for (const row of teacherRows) {
        if (!row.student_id) continue;

        const teacherId = String(row.teacher_id);
        const schoolId = String(row.school_id);
        const subjectId = String(row.subject_id);
        const studentId = String(row.student_id);

        const subjectKey = [
            teacherId,
            schoolId,
            subjectId
        ].join("_");

        const overallKey = [
            teacherId,
            schoolId
        ].join("_");

        const learnerKey = studentId;

        /*
         * Teacher subject metadata.
         */
        if (!teacherSubjectMetadata.has(subjectKey)) {
            teacherSubjectMetadata.set(subjectKey, {
                teacher_id: teacherId,
                teacher: row.teacher_name,
                school_id: schoolId,
                school: row.school_name,
                subject_id: subjectId,
                subject: row.subject_name,
                subject_code: row.subject_code
            });
        }

        /*
         * Teacher overall metadata.
         */
        if (!teacherOverallMetadata.has(overallKey)) {
            teacherOverallMetadata.set(overallKey, {
                teacher_id: teacherId,
                teacher: row.teacher_name,
                school_id: schoolId,
                school: row.school_name
            });
        }

        /*
         * Teacher subject learner map.
         */
        if (!teacherSubjectLearners.has(subjectKey)) {
            teacherSubjectLearners.set(
                subjectKey,
                new Map()
            );
        }

        const subjectLearners =
            teacherSubjectLearners.get(subjectKey);

        if (!subjectLearners.has(learnerKey)) {
            subjectLearners.set(
                learnerKey,
                createLearnerEntry({
                    student_id: studentId,
                    school_id: schoolId
                })
            );
        }

        addLearnerResult(
            subjectLearners.get(learnerKey),
            row
        );

        /*
         * Teacher overall learner map.
         */
        if (!teacherOverallLearners.has(overallKey)) {
            teacherOverallLearners.set(
                overallKey,
                new Map()
            );
        }

        const overallLearnersForTeacher =
            teacherOverallLearners.get(overallKey);

        if (!overallLearnersForTeacher.has(learnerKey)) {
            overallLearnersForTeacher.set(
                learnerKey,
                createLearnerEntry({
                    student_id: studentId,
                    school_id: schoolId
                })
            );
        }

        addLearnerResult(
            overallLearnersForTeacher.get(learnerKey),
            row
        );
    }


    /* =====================================================
       FINAL TEACHER SUBJECT PERFORMANCE
    ===================================================== */

    
    /* =====================================================
       TEACHER PERFORMANCE BY SUBJECT

       Group teachers by subject.
       Rank teachers separately within each subject.
       Highest average percentage ranks first.
    ===================================================== */

    const teacherSubjects = Array.from(
        teacherSubjectLearners.entries()
    ).map(([key, learners]) => ({
        ...teacherSubjectMetadata.get(key),
        ...finishLearnerMap(learners)
    }));

    // Group teachers by subject.
    const teacherSubjectGroups = new Map();

    for (const teacher of teacherSubjects) {
        const subjectKey = String(teacher.subject_id);

        if (!teacherSubjectGroups.has(subjectKey)) {
            teacherSubjectGroups.set(subjectKey, {
                subject_id: teacher.subject_id,
                subject: teacher.subject,
                subject_code: teacher.subject_code,
                teachers: []
            });
        }

        teacherSubjectGroups
            .get(subjectKey)
            .teachers
            .push(teacher);
    }

    // Rank teachers independently inside each subject.
    const rankedTeacherSubjects = Array.from(
        teacherSubjectGroups.values()
    ).map(group => {
        group.teachers.sort((a, b) =>
            
            b.pass_rate - a.pass_rate ||
            b.average_percentage - a.average_percentage ||
            b.passed - a.passed ||
            a.teacher.localeCompare(b.teacher)
        );

        return {
            subject_id: group.subject_id,
            subject: group.subject,
            subject_code: group.subject_code,

            teachers: group.teachers.map((teacher, index) => ({
                rank: index + 1,
                ...teacher
            }))
        };
    }).sort((a, b) =>
        a.subject.localeCompare(b.subject)
    );

// Collect all subjects taught by each teacher in the school.
const teacherSubjectsByOverall = new Map();

for (const item of teacherSubjects) {
    const key = [
        item.teacher_id,
        item.school_id
    ].join("_");

    if (!teacherSubjectsByOverall.has(key)) {
        teacherSubjectsByOverall.set(key, []);
    }

    const subjects = teacherSubjectsByOverall.get(key);

    if (!subjects.some(subject => subject.subject_id === item.subject_id)) {
        subjects.push({
            subject_id: item.subject_id,
            subject: item.subject,
            subject_code: item.subject_code
        });
    }
}

    /* =====================================================
       FINAL OVERALL TEACHER PERFORMANCE
    ===================================================== */

    const teachers = Array.from(
    teacherOverallLearners.entries()
).map(([key, learners]) => ({
    ...teacherOverallMetadata.get(key),

    subjects: teacherSubjectsByOverall.get(key) || [],

    ...finishLearnerMap(learners)
}))
    .sort((a, b) =>
        
        b.pass_rate - a.pass_rate ||
        b.average_percentage - a.average_percentage ||
        a.teacher.localeCompare(b.teacher)
    )
    .map((item, index) => ({
        rank: index + 1,
        ...item
    }));


    /* =====================================================
       SUMMARY
    ===================================================== */

    const summary = {
        academic_year: academicYear,

        total_tests: tests.length,

        tests_with_results: testPerformance.filter(
            item => item.recorded > 0
        ).length,

        total_schools: schools.length,

        total_subjects: subjects.length,

        total_teachers: teachers.length,

        /*
         * These are unique learners, not learner-subject
         * result opportunities.
         */
        total_candidates: overall.candidates,

        total_recorded: overall.recorded,

        total_missing: overall.missing,

        total_passed: overall.passed,

        total_failed: overall.failed,

        average_percentage: overall.average_percentage,

        pass_rate: overall.pass_rate,

        /*
         * Kept for compatibility with existing dashboard
         * code. This is now the percentage of learners
         * with at least one valid recorded result.
         */
        recording_rate: overall.recording_rate
    };


    /* =====================================================
       RESPONSE DATA

       Existing property names are retained for compatibility
       with the current dashboard while the learner counts
       and overall percentages are corrected.
    ===================================================== */

    return {
        summary,

        performance_distribution: {
            bands: bands.map(band => ({
                label: band.label,
                count: band.count
            })),

            school_breakdown: schoolBands,

            leading_schools: bandWinners
        },

        school_ranking: schools,

        gender_analysis: genders,

        subject_performance: subjects,

        grade_distribution: grades,

        teacher_subject_performance: rankedTeacherSubjects,

        teacher_overall_performance: teachers,

        academic_year_progress: testPerformance,

        /*
         * Retained temporarily for API compatibility.
         * Remove the marks-recording section from the HTML
         * dashboard and its exports as requested.
         */
        marks_recording: {
            overall: {
                candidates: overall.candidates,
                recorded: overall.recorded,
                missing: overall.missing,
                completion_rate: overall.recording_rate
            },

            schools: schools.map(school => ({
                school_id: school.school_id,
                school: school.school,
                candidates: school.candidates,
                recorded: school.recorded,
                missing: school.missing,
                completion_rate: school.recording_rate
            }))
        }
    };
}


/* =========================================================
   MAIN API HANDLER
========================================================= */

export async function onRequestGet(context) {
    const auth = await authenticateRole(
        context,
        "sector_admin"
    );

    if (auth.error) return auth.error;

    if (!auth.sectorId) {
        return json({
            success: false,
            message: "Your account is not linked to a sector."
        }, 403);
    }

    const url = new URL(context.request.url);

    const action = (
        url.searchParams.get("action") || "report"
    ).toLowerCase();

    const academicYear =
        url.searchParams.get("academic_year");

    const requestedTestId =
        url.searchParams.get("test_id");

    const testId = requestedTestId
        ? validId(requestedTestId)
        : null;

    if (requestedTestId && !testId) {
        return json({
            success: false,
            message: "Please select a valid test."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);


        /* ---------------------------------------------
           ACTION: ACADEMIC YEARS
        --------------------------------------------- */

        if (action === "years") {
            const years = await getAcademicYears(
                client,
                auth.sectorId
            );

            return json({
                success: true,
                academic_years: years
            });
        }


        /* ---------------------------------------------
           ACTION: TESTS
        --------------------------------------------- */

        if (action === "tests") {
            if (!academicYear) {
                return json({
                    success: false,
                    message: "Please select an academic year."
                }, 400);
            }

            const tests = await getAcademicYearTests(
                client,
                auth.sectorId,
                academicYear
            );

            return json({
                success: true,
                academic_year: academicYear,
                tests
            });
        }


        /* ---------------------------------------------
           VALIDATE REPORT REQUEST
        --------------------------------------------- */

        if (action !== "report") {
            return json({
                success: false,
                message: "Invalid reporting action."
            }, 400);
        }

        if (!academicYear) {
            return json({
                success: false,
                message: "Please select an academic year."
            }, 400);
        }


        /* ---------------------------------------------
           VALIDATE TEST IF SELECTED
        --------------------------------------------- */

        let selectedTest = null;

        if (testId) {
            selectedTest = await getSectorTest(
                client,
                testId,
                auth.sectorId
            );

            if (!selectedTest) {
                return json({
                    success: false,
                    message: "This test is not accessible within your sector."
                }, 403);
            }

            const yearCheck = await client.query(
                `
                SELECT 1

                FROM test_schools ts

                INNER JOIN schools s
                    ON s.id = ts.school_id
                   AND s.sector_id = $1

                INNER JOIN academic_years ay
                    ON ay.id = ts.academic_year_id
                   AND ay.school_id = ts.school_id

                WHERE ts.test_id = $2
                  AND ay.year_name = $3

                LIMIT 1
                `,
                [
                    auth.sectorId,
                    testId,
                    academicYear
                ]
            );

            if (!yearCheck.rows.length) {
                return json({
                    success: false,
                    message: "The selected test does not belong to the selected academic year."
                }, 400);
            }
        }


        /* ---------------------------------------------
           GET TESTS IN SELECTED YEAR
        --------------------------------------------- */

        const tests = await getAcademicYearTests(
            client,
            auth.sectorId,
            academicYear
        );

        const reportTests = testId
            ? tests.filter(
                item => String(item.id) === String(testId)
            )
            : tests;


        /* ---------------------------------------------
           LOAD STUDENT RESULTS
        --------------------------------------------- */

        const resultRows = await getResultRows(
            client,
            auth.sectorId,
            academicYear,
            testId
        );


        /* ---------------------------------------------
           LOAD TEACHER RESULTS
        --------------------------------------------- */

        const teacherRows = await getTeacherRows(
            client,
            auth.sectorId,
            academicYear,
            testId
        );


        /* ---------------------------------------------
           BUILD REPORT DATA
        --------------------------------------------- */

        const reports = buildReports(
            resultRows,
            teacherRows,
            reportTests,
            academicYear
        );


        /* ---------------------------------------------
           RESPONSE
        --------------------------------------------- */

        return json({
            success: true,

            report_type: testId
                ? "individual_test"
                : "academic_year",

            academic_year: academicYear,

            selected_test: selectedTest
                ? {
                    id: String(selectedTest.id),
                    name: selectedTest.test_name,
                    status: selectedTest.status,
                    created_at: selectedTest.created_at
                }
                : null,

            tests: reportTests,

            reports
        });

    } catch (error) {
        console.error(
            "Sector Tests Reports API error:",
            {
                message: error?.message,
                code: error?.code,
                detail: error?.detail,
                table: error?.table,
                column: error?.column,
                constraint: error?.constraint
            }
        );

        return json({
            success: false,
            message: "Unable to generate sector reports."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
