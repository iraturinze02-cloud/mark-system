
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

   Reports:
   - Academic-year overview across all terms and tests
   - Individual test analysis
   - Ten-mark performance distribution
   - School performance ranking
   - Gender performance
   - Subject performance
   - Success-category distribution
   - Teacher performance by subject
   - Overall teacher performance
   - Marks-recording completion

   IMPORTANT:
   - Does not modify existing reporting endpoints.
   - Uses school-specific academic_year_id and term_id.
   - Uses active student enrollments for the relevant period.
   - Uses the latest mark record for each test/student/class/subject.
   - Teacher assignments must match the academic year and term.
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

function addResult(target, row) {
    target.candidates++;

    if (row.score === null || row.score === undefined) {
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
        ...emptyCounters()
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

   Academic years are school-specific in the database.
   We therefore return distinct year_name values for the
   schools participating in tests within the sector.
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

   Students are selected using the enrollment matching
   the academic year and term attached to that school
   in test_schools.

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
                se.term_id

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

   Teacher assignments are matched using:
   - school
   - class
   - subject
   - academic year
   - term

   This prevents historical reports from attributing
   marks to a teacher assigned in another period.

   Assignments with NULL academic_year_id or term_id
   are intentionally excluded from period-specific
   teacher performance.
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
                se.term_id

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

            ta.teacher_id,
            u.full_name AS teacher_name,

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

        INNER JOIN teacher_assignments ta
            ON ta.school_id = ts.school_id
           AND ta.class_id = tc.class_id
           AND ta.subject_id = sub.id
           AND ta.academic_year_id = ts.academic_year_id
           AND ta.term_id = ts.term_id

        INNER JOIN teachers teacher
            ON teacher.id = ta.teacher_id
           AND teacher.school_id = ta.school_id

        INNER JOIN users u
            ON u.id = teacher.user_id
           AND u.school_id = teacher.school_id
           AND u.role = 'teacher'

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
            u.full_name,
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

function buildReports(rows, teacherRows, tests, academicYear) {
    const overall = emptyCounters();

    const schoolMap = new Map();
    const subjectMap = new Map();
    const genderMap = new Map();

    const gradeMap = {
        A: 0,
        B: 0,
        C: 0,
        D: 0,
        E: 0,
        S: 0,
        F: 0
    };

    const bands = createBandCounters();
    const schoolBandMap = new Map();

    const testMap = new Map();

    const seenStudents = new Set();

    for (const row of rows) {
        const testId = String(row.test_id);

        if (!testMap.has(testId)) {
            testMap.set(testId, {
                id: testId,
                name: row.test_name,
                status: row.test_status,
                created_at: row.test_created_at,
                terms: new Set(),
                schools: new Set(),
                ...emptyCounters()
            });
        }

        const testEntry = testMap.get(testId);

        testEntry.terms.add(num(row.term_number));
        testEntry.schools.add(String(row.school_id));

        if (!schoolMap.has(String(row.school_id))) {
            schoolMap.set(
                String(row.school_id),
                createSchoolEntry(row)
            );
        }

        if (!subjectMap.has(String(row.subject_id))) {
            subjectMap.set(
                String(row.subject_id),
                createSubjectEntry(row)
            );
        }

        if (!row.student_id) {
            continue;
        }

        const maximum = num(row.total_marks);

        const score = row.score === null
            ? null
            : num(row.score);

        const resultPercentage =
            score !== null && maximum > 0
                ? round((score / maximum) * 100)
                : null;

        const resultRow = {
            score,
            percentage: resultPercentage
        };

        const studentKey = [
            testId,
            row.school_id,
            row.class_id,
            row.student_id
        ].join("_");

        seenStudents.add(studentKey);

        addResult(overall, resultRow);
        addResult(schoolMap.get(String(row.school_id)), resultRow);
        addResult(subjectMap.get(String(row.subject_id)), resultRow);
        addResult(testEntry, resultRow);

        if (score === null || resultPercentage === null) {
            continue;
        }

        const bandIndex = getBand(resultPercentage);

        bands[bandIndex].count++;

        const schoolId = String(row.school_id);

        if (!schoolBandMap.has(schoolId)) {
            schoolBandMap.set(schoolId, {
                school_id: schoolId,
                school: row.school_name,
                bands: createBandCounters()
            });
        }

        schoolBandMap.get(schoolId).bands[bandIndex].count++;

        const grade = gradeCategory(resultPercentage);
        gradeMap[grade]++;

        const gender = String(row.gender || "")
            .trim()
            .toLowerCase();

        let genderLabel = "Not specified";

        if (gender === "male" || gender === "m") {
            genderLabel = "Male";
        } else if (gender === "female" || gender === "f") {
            genderLabel = "Female";
        }

        if (!genderMap.has(genderLabel)) {
            genderMap.set(genderLabel, {
                gender: genderLabel,
                ...emptyCounters()
            });
        }

        addResult(genderMap.get(genderLabel), resultRow);
    }


    /* -----------------------------------------------------
       SCHOOL RANKING
    ----------------------------------------------------- */

    const schools = Array.from(schoolMap.values())
        .map(item => ({
            school_id: item.school_id,
            school: item.school,
            ...finishCounters(item)
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


    /* -----------------------------------------------------
       SUBJECT PERFORMANCE
    ----------------------------------------------------- */

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


    /* -----------------------------------------------------
       GENDER ANALYSIS
    ----------------------------------------------------- */

    const genders = Array.from(genderMap.values())
        .map(item => ({
            gender: item.gender,
            ...finishCounters(item)
        }));


    /* -----------------------------------------------------
       SCHOOL PERFORMANCE BY SCORE BAND
    ----------------------------------------------------- */

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


    /* -----------------------------------------------------
       GRADE DISTRIBUTION
    ----------------------------------------------------- */

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


    /* -----------------------------------------------------
       TEST PERFORMANCE / YEAR PROGRESS
    ----------------------------------------------------- */

    const testPerformance = Array.from(testMap.values())
        .map(item => ({
            id: item.id,
            name: item.name,
            status: item.status,
            created_at: item.created_at,
            terms: Array.from(item.terms).sort((a, b) => a - b),
            total_schools: item.schools.size,
            ...finishCounters(item)
        }))
        .sort((a, b) =>
            new Date(a.created_at) - new Date(b.created_at)
        );


    /* -----------------------------------------------------
       TEACHER PERFORMANCE

       Each teacher-subject-class assignment is counted
       once for each candidate result.

       Overall teacher performance is weighted by the
       number of recorded learner-subject results.
    ----------------------------------------------------- */

    const teacherSubjectMap = new Map();
    const teacherOverallMap = new Map();

    for (const row of teacherRows) {
        if (!row.student_id) continue;

        const score = row.score === null
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

        const teacherId = String(row.teacher_id);
        const schoolId = String(row.school_id);
        const subjectId = String(row.subject_id);

        const subjectKey = [
            teacherId,
            schoolId,
            subjectId
        ].join("_");

        const overallKey = [
            teacherId,
            schoolId
        ].join("_");

        if (!teacherSubjectMap.has(subjectKey)) {
            teacherSubjectMap.set(subjectKey, {
                teacher_id: teacherId,
                teacher: row.teacher_name,
                school_id: schoolId,
                school: row.school_name,
                subject_id: subjectId,
                subject: row.subject_name,
                subject_code: row.subject_code,
                ...emptyCounters()
            });
        }

        if (!teacherOverallMap.has(overallKey)) {
            teacherOverallMap.set(overallKey, {
                teacher_id: teacherId,
                teacher: row.teacher_name,
                school_id: schoolId,
                school: row.school_name,
                ...emptyCounters()
            });
        }

        addResult(
            teacherSubjectMap.get(subjectKey),
            resultRow
        );

        addResult(
            teacherOverallMap.get(overallKey),
            resultRow
        );
    }

    const teacherSubjects = Array.from(teacherSubjectMap.values())
        .map(item => ({
            teacher_id: item.teacher_id,
            teacher: item.teacher,
            school_id: item.school_id,
            school: item.school,
            subject_id: item.subject_id,
            subject: item.subject,
            subject_code: item.subject_code,
            ...finishCounters(item)
        }))
        .sort((a, b) =>
            a.school.localeCompare(b.school) ||
            a.teacher.localeCompare(b.teacher) ||
            a.subject.localeCompare(b.subject)
        );

    const teachers = Array.from(teacherOverallMap.values())
        .map(item => ({
            teacher_id: item.teacher_id,
            teacher: item.teacher,
            school_id: item.school_id,
            school: item.school,
            ...finishCounters(item)
        }))
        .sort((a, b) =>
            b.average_percentage - a.average_percentage ||
            b.pass_rate - a.pass_rate ||
            a.teacher.localeCompare(b.teacher)
        )
        .map((item, index) => ({
            rank: index + 1,
            ...item
        }));


    /* -----------------------------------------------------
       MARKS RECORDING COMPLETION
    ----------------------------------------------------- */

    const recording = {
        candidates: overall.candidates,
        recorded: overall.recorded,
        missing: overall.missing,
        completion_rate: percentage(
            overall.recorded,
            overall.candidates
        )
    };

    const schoolRecording = schools.map(school => ({
        school_id: school.school_id,
        school: school.school,
        candidates: school.candidates,
        recorded: school.recorded,
        missing: school.missing,
        completion_rate: school.recording_rate
    }));


    /* -----------------------------------------------------
       SUMMARY
    ----------------------------------------------------- */

    const summary = {
        academic_year: academicYear,

        total_tests: tests.length,

        tests_with_results: testPerformance.length,

        total_schools: schools.length,

        total_subjects: subjects.length,

        total_teachers: teachers.length,

        total_candidates: overall.candidates,

        total_recorded: overall.recorded,

        total_missing: overall.missing,

        total_passed: overall.passed,

        total_failed: overall.failed,

        average_percentage: overall.recorded > 0
            ? round(
                overall.percentage_sum / overall.recorded
            )
            : 0,

        pass_rate: percentage(
            overall.passed,
            overall.recorded
        ),

        recording_rate: recording.completion_rate
    };

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

        teacher_subject_performance: teacherSubjects,

        teacher_overall_performance: teachers,

        academic_year_progress: testPerformance,

        marks_recording: {
            overall: recording,
            schools: schoolRecording
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
