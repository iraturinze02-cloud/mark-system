
import {
    connectDB,
    requireTestUser,
    json
} from "../_utils.js";

/* =====================================================
   HELPERS
===================================================== */

function uniqueIds(values) {
    if (!Array.isArray(values)) return [];

    return [
        ...new Set(
            values
                .map(value => String(value).trim())
                .filter(value => /^\d+$/.test(value))
        )
    ];
}

function validClosingAt(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
        return undefined;
    }

    return date.toISOString();
}

/*
 * A teacher must belong to exactly one school.
 * The school is always derived from database assignments.
 */
async function getTeacherSchool(client, userId) {
    const result = await client.query(
        `
        SELECT DISTINCT ta.school_id
        FROM teachers tr
        INNER JOIN teacher_assignments ta
            ON ta.teacher_id = tr.id
        WHERE tr.user_id = $1
        ORDER BY ta.school_id
        `,
        [userId]
    );

    if (result.rows.length === 0) {
        throw new Error(
            "You do not have any teaching assignments."
        );
    }

    if (result.rows.length !== 1) {
        throw new Error(
            "Your teaching assignments are linked to more than one school. Please contact your school administrator."
        );
    }

    return String(result.rows[0].school_id);
}

/* =====================================================
   VALIDATE SUBJECT MAXIMUM MARKS
===================================================== */

function validateSubjectMarks(subjectIds, subjectMarks) {
    const marksMap = new Map(
        subjectIds.map(id => [id, 100])
    );

    if (
        subjectMarks === null ||
        subjectMarks === undefined ||
        (Array.isArray(subjectMarks) && subjectMarks.length === 0)
    ) {
        return {
            valid: true,
            marks: subjectIds.map(subjectId => ({
                subject_id: subjectId,
                total_marks: 100
            }))
        };
    }

    if (!Array.isArray(subjectMarks)) {
        return {
            valid: false,
            message: "Invalid subject maximum marks data."
        };
    }

    const suppliedSubjects = new Set();

    for (const item of subjectMarks) {
        if (!item || typeof item !== "object") {
            return {
                valid: false,
                message: "Invalid subject maximum marks data."
            };
        }

        const subjectId = String(
            item.subject_id ?? item.subjectId ?? ""
        ).trim();

        if (!/^\d+$/.test(subjectId)) {
            return {
                valid: false,
                message: "Invalid subject selected."
            };
        }

        if (!subjectIds.includes(subjectId)) {
            return {
                valid: false,
                message: "Maximum marks were provided for an unselected subject."
            };
        }

        if (suppliedSubjects.has(subjectId)) {
            return {
                valid: false,
                message: "Duplicate subject maximum marks were provided."
            };
        }

        suppliedSubjects.add(subjectId);

        const rawMarks = item.total_marks ?? item.totalMarks;

        if (
            rawMarks === null ||
            rawMarks === undefined ||
            String(rawMarks).trim() === ""
        ) {
            marksMap.set(subjectId, 100);
            continue;
        }

        const totalMarks = Number(rawMarks);

        if (!Number.isFinite(totalMarks) || totalMarks <= 0) {
            return {
                valid: false,
                message: "Maximum marks must be a positive number."
            };
        }

        marksMap.set(subjectId, totalMarks);
    }

    return {
        valid: true,
        marks: subjectIds.map(subjectId => ({
            subject_id: subjectId,
            total_marks: marksMap.get(subjectId)
        }))
    };
}

/* =====================================================
   CLOSE EXPIRED TESTS
===================================================== */

async function closeExpiredTests(client) {
    await client.query(`
        UPDATE tests
        SET
            status = 'closed',
            closed_at = NOW(),
            updated_at = NOW()
        WHERE status = 'open'
          AND closing_at IS NOT NULL
          AND closing_at <= NOW()
    `);
}

/* =====================================================
   GET: LOAD TESTS
===================================================== */

export async function onRequestGet(context) {
    const auth = await requireTestUser(context);

    if (auth.error) return auth.error;

    let client;

    try {
        client = await connectDB(context);

        await closeExpiredTests(client);

        let teacherSchoolId = null;

        if (auth.role === "teacher") {
            teacherSchoolId = await getTeacherSchool(
                client,
                auth.userId
            );
        }

        let visibilityCondition = "";
        const parameters = [];

        /* ---------------------------------------------
           SECTOR ADMIN
        --------------------------------------------- */

        if (auth.role === "sector_admin") {
            visibilityCondition = `t.sector_id = $1`;
            parameters.push(auth.sectorId);
        }

        /* ---------------------------------------------
           SCHOOL ADMIN AND DOS
        --------------------------------------------- */

        else if (["school_admin", "dos"].includes(auth.role)) {
            if (!auth.schoolId) {
                return json({
                    success: false,
                    message: "Your account is not linked to a school."
                }, 403);
            }

            visibilityCondition = `
                (
                    t.school_id = $1
                    OR EXISTS (
                        SELECT 1
                        FROM test_schools visible_school
                        WHERE visible_school.test_id = t.id
                          AND visible_school.school_id = $1
                    )
                )
            `;

            parameters.push(auth.schoolId);
        }

        /* ---------------------------------------------
           TEACHER

           Teachers see tests matching their assigned
           class-subject combinations in their school.

           This includes tests created by administrators
           and other teachers.
        --------------------------------------------- */

        else if (auth.role === "teacher") {
            visibilityCondition = `
                EXISTS (
                    SELECT 1
                    FROM teachers tr

                    INNER JOIN teacher_assignments ta
                        ON ta.teacher_id = tr.id

                    INNER JOIN test_classes tc
                        ON tc.test_id = t.id
                       AND tc.class_id = ta.class_id
                       AND tc.school_id = ta.school_id

                    INNER JOIN test_subjects tsu
                        ON tsu.test_id = t.id
                       AND tsu.subject_id = ta.subject_id

                    INNER JOIN classes assigned_class
                        ON assigned_class.id = ta.class_id

                    INNER JOIN school_levels sl
                        ON sl.school_id = ta.school_id
                       AND sl.level_id = assigned_class.level_id

                    WHERE tr.user_id = $1
                      AND ta.school_id = $2
                )
            `;

            parameters.push(
                auth.userId,
                teacherSchoolId
            );
        }

        else {
            return json({
                success: false,
                message: "Not authorized."
            }, 403);
        }

        /* ---------------------------------------------
           ACADEMIC PERIOD FILTERS
        --------------------------------------------- */

        const url = new URL(context.request.url);

        const requestedSchoolId =
            url.searchParams.get("school_id");

        const academicYearId =
            url.searchParams.get("academic_year_id");

        const termId =
            url.searchParams.get("term_id");

        const filterRequested =
            requestedSchoolId !== null ||
            academicYearId !== null ||
            termId !== null;

        let periodFilterCondition = "";

        if (filterRequested) {
            if (
                requestedSchoolId === null ||
                academicYearId === null ||
                termId === null ||
                !/^\d+$/.test(requestedSchoolId) ||
                !/^\d+$/.test(academicYearId) ||
                !/^\d+$/.test(termId)
            ) {
                return json({
                    success: false,
                    message:
                        "Provide a valid school, academic year and term."
                }, 400);
            }

            if (
                ["school_admin", "dos"].includes(auth.role) &&
                String(auth.schoolId) !== requestedSchoolId
            ) {
                return json({
                    success: false,
                    message:
                        "You cannot filter tests for another school."
                }, 403);
            }

            if (
                auth.role === "teacher" &&
                teacherSchoolId !== requestedSchoolId
            ) {
                return json({
                    success: false,
                    message:
                        "You cannot filter tests for another school."
                }, 403);
            }

            if (auth.role === "sector_admin") {
                const selectedSchool = await client.query(
                    `
                    SELECT id
                    FROM schools
                    WHERE id = $1
                      AND sector_id = $2
                    LIMIT 1
                    `,
                    [
                        requestedSchoolId,
                        auth.sectorId
                    ]
                );

                if (selectedSchool.rows.length === 0) {
                    return json({
                        success: false,
                        message:
                            "The selected school does not belong to your sector."
                    }, 403);
                }
            }

            const schoolParameter = parameters.length + 1;
            const yearParameter = parameters.length + 2;
            const termParameter = parameters.length + 3;

            periodFilterCondition = `
                AND EXISTS (
                    SELECT 1
                    FROM test_schools period_filter
                    WHERE period_filter.test_id = t.id
                      AND period_filter.school_id =
                          $${schoolParameter}::bigint
                      AND period_filter.academic_year_id =
                          $${yearParameter}::bigint
                      AND period_filter.term_id =
                          $${termParameter}::bigint
                )
            `;

            parameters.push(
                requestedSchoolId,
                academicYearId,
                termId
            );
        }

        /* ---------------------------------------------
           MANAGEMENT SCOPE
        --------------------------------------------- */

        const manageScopeId =
            auth.role === "sector_admin"
                ? auth.sectorId
                : ["school_admin", "dos"].includes(auth.role)
                    ? auth.schoolId
                    : null;

        const roleParameter = parameters.length + 1;
        const scopeParameter = parameters.length + 2;
        const userParameter = parameters.length + 3;

        /* ---------------------------------------------
           LOAD TESTS
        --------------------------------------------- */

        const testsResult = await client.query(
            `
            SELECT
                t.id,
                t.test_name,
                t.sector_id,
                t.school_id,
                t.created_by,
                t.status,
                t.closing_at,
                t.initiated_at,
                t.closed_at,
                t.created_at,
                t.updated_at,

                creator.full_name AS creator_name,

                CASE
                    WHEN $${roleParameter}::text = 'sector_admin'
                         AND t.sector_id = $${scopeParameter}::bigint
                    THEN TRUE

                    WHEN $${roleParameter}::text IN ('school_admin', 'dos')
                         AND t.school_id = $${scopeParameter}::bigint
                    THEN TRUE

                    WHEN $${roleParameter}::text = 'teacher'
                         AND t.created_by = $${userParameter}::bigint
                         AND t.school_id = $${scopeParameter}::bigint
                    THEN TRUE

                    ELSE FALSE
                END AS can_manage,

                COALESCE(test_schools.data, '[]'::json) AS schools,
                COALESCE(test_classes.data, '[]'::json) AS classes,
                COALESCE(test_subjects.data, '[]'::json) AS subjects

            FROM tests t

            LEFT JOIN users creator
                ON creator.id = t.created_by

            /* TEST SCHOOLS AND PERIODS */

            LEFT JOIN LATERAL (
                SELECT json_agg(
                    json_build_object(
                        'id', s.id,
                        'school_name', s.school_name,
                        'academic_year_id', ts.academic_year_id,
                        'year_name', ay.year_name,
                        'term_id', ts.term_id,
                        'term_name', tm.term_name,
                        'term_number', tm.term_number
                    )
                    ORDER BY s.school_name
                ) AS data

                FROM test_schools ts

                INNER JOIN schools s
                    ON s.id = ts.school_id

                LEFT JOIN academic_years ay
                    ON ay.id = ts.academic_year_id
                   AND ay.school_id = ts.school_id

                LEFT JOIN terms tm
                    ON tm.id = ts.term_id
                   AND tm.academic_year_id = ts.academic_year_id
                   AND tm.school_id = ts.school_id

                WHERE ts.test_id = t.id
            ) test_schools ON TRUE

            /* TEST CLASSES */

            LEFT JOIN LATERAL (
                SELECT json_agg(
                    json_build_object(
                        'id', c.id,
                        'class_name', c.class_name,
                        'class_level',
                            CASE c.level_id
                                WHEN 1 THEN 'Primary'
                                WHEN 2 THEN 'Lower Secondary'
                                WHEN 3 THEN 'Upper Secondary'
                                ELSE 'Unknown'
                            END,
                        'school_id', tc.school_id
                    )
                    ORDER BY tc.school_id, c.class_name
                ) AS data

                FROM test_classes tc

                INNER JOIN classes c
                    ON c.id = tc.class_id

                INNER JOIN school_levels sl
                    ON sl.school_id = tc.school_id
                   AND sl.level_id = c.level_id

                WHERE tc.test_id = t.id
            ) test_classes ON TRUE

            /* TEST SUBJECTS */

            LEFT JOIN LATERAL (
                SELECT json_agg(
                    json_build_object(
                        'id', s.id,
                        'subject_name', s.subject_name,
                        'subject_code', s.subject_code,
                        'total_marks', ts.total_marks
                    )
                    ORDER BY s.subject_name
                ) AS data

                FROM test_subjects ts

                INNER JOIN subjects s
                    ON s.id = ts.subject_id

                WHERE ts.test_id = t.id
            ) test_subjects ON TRUE

            WHERE ${visibilityCondition}
            ${periodFilterCondition}

            ORDER BY t.created_at DESC
            `,
            [
                ...parameters,
                auth.role,
                manageScopeId,
                auth.userId
            ]
        );

        /* ---------------------------------------------
           LOAD SCHOOLS FOR TEST FORM
        --------------------------------------------- */

        let schools = [];

        if (auth.role === "sector_admin") {
            const result = await client.query(
                `
                SELECT id, school_name, school_code
                FROM schools
                WHERE sector_id = $1
                  AND status = 'active'
                ORDER BY school_name
                `,
                [auth.sectorId]
            );

            schools = result.rows;
        }

        else if (["school_admin", "dos"].includes(auth.role)) {
            const result = await client.query(
                `
                SELECT id, school_name, school_code
                FROM schools
                WHERE id = $1
                  AND status = 'active'
                `,
                [auth.schoolId]
            );

            schools = result.rows;
        }

        else if (auth.role === "teacher") {
            const result = await client.query(
                `
                SELECT id, school_name, school_code
                FROM schools
                WHERE id = $1
                  AND status = 'active'
                `,
                [teacherSchoolId]
            );

            schools = result.rows;
        }

        /* ---------------------------------------------
           LOAD CLASSES FOR TEST FORM
        --------------------------------------------- */

        let classes = [];

        if (auth.role === "sector_admin") {
            const result = await client.query(
                `
                SELECT
                    c.id,
                    c.class_name,
                    CASE c.level_id
                        WHEN 1 THEN 'Primary'
                        WHEN 2 THEN 'Lower Secondary'
                        WHEN 3 THEN 'Upper Secondary'
                        ELSE 'Unknown'
                    END AS class_level,
                    sl.school_id,
                    s.school_name

                FROM classes c

                INNER JOIN school_levels sl
                    ON sl.level_id = c.level_id

                INNER JOIN schools s
                    ON s.id = sl.school_id

                WHERE s.sector_id = $1
                  AND s.status = 'active'

                ORDER BY
                    s.school_name,
                    c.level_id,
                    c.class_name
                `,
                [auth.sectorId]
            );

            classes = result.rows;
        }

        else if (["school_admin", "dos"].includes(auth.role)) {
            const result = await client.query(
                `
                SELECT
                    c.id,
                    c.class_name,
                    CASE c.level_id
                        WHEN 1 THEN 'Primary'
                        WHEN 2 THEN 'Lower Secondary'
                        WHEN 3 THEN 'Upper Secondary'
                        ELSE 'Unknown'
                    END AS class_level,
                    sl.school_id

                FROM classes c

                INNER JOIN school_levels sl
                    ON sl.level_id = c.level_id

                WHERE sl.school_id = $1

                ORDER BY c.level_id, c.class_name
                `,
                [auth.schoolId]
            );

            classes = result.rows;
        }

        else if (auth.role === "teacher") {
            const result = await client.query(
                `
                SELECT DISTINCT
                    c.id,
                    c.class_name,
                    CASE c.level_id
                        WHEN 1 THEN 'Primary'
                        WHEN 2 THEN 'Lower Secondary'
                        WHEN 3 THEN 'Upper Secondary'
                        ELSE 'Unknown'
                    END AS class_level,
                    ta.school_id

                FROM teachers tr

                INNER JOIN teacher_assignments ta
                    ON ta.teacher_id = tr.id

                INNER JOIN classes c
                    ON c.id = ta.class_id

                INNER JOIN school_levels sl
                    ON sl.school_id = ta.school_id
                   AND sl.level_id = c.level_id

                WHERE tr.user_id = $1
                  AND ta.school_id = $2

                ORDER BY c.class_name
                `,
                [
                    auth.userId,
                    teacherSchoolId
                ]
            );

            classes = result.rows;
        }

        /* ---------------------------------------------
           LOAD SUBJECTS
        --------------------------------------------- */

        let subjectsResult;

        if (auth.role === "teacher") {
            subjectsResult = await client.query(
                `
                SELECT DISTINCT
                    s.id,
                    s.subject_name,
                    s.subject_code

                FROM teachers tr

                INNER JOIN teacher_assignments ta
                    ON ta.teacher_id = tr.id

                INNER JOIN subjects s
                    ON s.id = ta.subject_id

                WHERE tr.user_id = $1
                  AND ta.school_id = $2

                ORDER BY s.subject_name
                `,
                [
                    auth.userId,
                    teacherSchoolId
                ]
            );
        } else {
            subjectsResult = await client.query(`
                SELECT id, subject_name, subject_code
                FROM subjects
                ORDER BY subject_name
            `);
        }

        return json({
            success: true,
            tests: testsResult.rows,
            schools,
            classes,
            subjects: subjectsResult.rows,

            user: {
                id: auth.userId,
                role: auth.role,
                sectorId: auth.sectorId,
                schoolId: auth.role === "teacher"
                    ? teacherSchoolId
                    : auth.schoolId
            }
        });

    } catch (error) {
        console.error("Load tests error:", error);

        const clientErrors = [
            "You do not have any teaching assignments.",
            "Your teaching assignments are linked to more than one school. Please contact your school administrator."
        ];

        return json({
            success: false,
            message: error.message || "Unable to load tests."
        }, clientErrors.includes(error.message) ? 403 : 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}

/* =====================================================
   POST: CREATE A TEST

   SECTOR ADMIN:
   - Creates sector tests for selected schools.

   SCHOOL ADMIN / DOS:
   - Creates tests for their own school.

   TEACHER:
   - School is derived from teacher assignments.
   - Exactly one school is required.
   - Only assigned class-subject combinations are allowed.
   - Uses the official test tables.
===================================================== */

export async function onRequestPost(context) {
    const auth = await requireTestUser(context);

    if (auth.error) return auth.error;

    if (
        ![
            "sector_admin",
            "school_admin",
            "dos",
            "teacher"
        ].includes(auth.role)
    ) {
        return json({
            success: false,
            message: "You are not authorized to create tests."
        }, 403);
    }

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid JSON request."
        }, 400);
    }

    const testName = String(
        data.test_name ?? data.testName ?? ""
    ).trim();

    if (!testName || testName.length > 200) {
        return json({
            success: false,
            message: "Enter a valid test name."
        }, 400);
    }

    const classIds = uniqueIds(
        data.class_ids ?? data.classIds
    );

    const subjectIds = uniqueIds(
        data.subject_ids ?? data.subjectIds
    );

    if (classIds.length === 0) {
        return json({
            success: false,
            message: "Select at least one class."
        }, 400);
    }

    if (subjectIds.length === 0) {
        return json({
            success: false,
            message: "Select at least one subject."
        }, 400);
    }

    const marksValidation = validateSubjectMarks(
        subjectIds,
        data.subject_marks ?? data.subjectMarks
    );

    if (!marksValidation.valid) {
        return json({
            success: false,
            message: marksValidation.message
        }, 400);
    }

    const subjectMarks = marksValidation.marks;

    const closingAt = validClosingAt(
        data.closing_at ?? data.closingAt
    );

    if (closingAt === undefined) {
        return json({
            success: false,
            message: "The closing date and time must be in the future."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* ---------------------------------------------
           DETERMINE SCHOOL IDS
        --------------------------------------------- */

        let schoolIds = [];

        if (auth.role === "sector_admin") {
            schoolIds = uniqueIds(
                data.school_ids ?? data.schoolIds
            );
        }

        else if (["school_admin", "dos"].includes(auth.role)) {
            if (!auth.schoolId) {
                throw new Error(
                    "Your account is not linked to a school."
                );
            }

            schoolIds = [String(auth.schoolId)];
        }

        else if (auth.role === "teacher") {
            const teacherSchoolId = await getTeacherSchool(
                client,
                auth.userId
            );

            schoolIds = [teacherSchoolId];
        }

        if (schoolIds.length === 0) {
            throw new Error("Select at least one school.");
        }

        /* ---------------------------------------------
           VALIDATE SCHOOLS
        --------------------------------------------- */

        let validSchools;

        if (auth.role === "sector_admin") {
            validSchools = await client.query(
                `
                SELECT id, school_name
                FROM schools
                WHERE id = ANY($1::bigint[])
                  AND sector_id = $2
                  AND status = 'active'
                `,
                [
                    schoolIds,
                    auth.sectorId
                ]
            );
        } else {
            validSchools = await client.query(
                `
                SELECT id, school_name
                FROM schools
                WHERE id = $1
                  AND status = 'active'
                `,
                [schoolIds[0]]
            );
        }

        if (validSchools.rows.length !== schoolIds.length) {
            throw new Error(
                "One or more selected schools are invalid."
            );
        }

        /* ---------------------------------------------
           VALIDATE TEACHER ASSIGNMENTS
        --------------------------------------------- */

        let validClasses;

        if (auth.role === "teacher") {
            const assignmentsResult = await client.query(
                `
                SELECT DISTINCT
                    ta.class_id,
                    ta.subject_id,
                    ta.school_id

                FROM teachers tr

                INNER JOIN teacher_assignments ta
                    ON ta.teacher_id = tr.id

                INNER JOIN classes c
                    ON c.id = ta.class_id

                INNER JOIN school_levels sl
                    ON sl.school_id = ta.school_id
                   AND sl.level_id = c.level_id

                WHERE tr.user_id = $1
                  AND ta.school_id = $2
                  AND ta.class_id = ANY($3::bigint[])
                  AND ta.subject_id = ANY($4::bigint[])
                `,
                [
                    auth.userId,
                    schoolIds[0],
                    classIds,
                    subjectIds
                ]
            );

            const assignedPairs = new Set(
                assignmentsResult.rows.map(row =>
                    `${row.class_id}:${row.subject_id}`
                )
            );

            /*
             * Every selected class must be assigned
             * together with every selected subject.
             */
            for (const classId of classIds) {
                for (const subjectId of subjectIds) {
                    if (
                        !assignedPairs.has(
                            `${classId}:${subjectId}`
                        )
                    ) {
                        throw new Error(
                            "You can only create tests for class and subject combinations assigned to you. Check your selected classes and subjects."
                        );
                    }
                }
            }

            const uniqueAssignedClasses = new Map();

            for (const row of assignmentsResult.rows) {
                const key = `${row.school_id}:${row.class_id}`;

                if (!uniqueAssignedClasses.has(key)) {
                    uniqueAssignedClasses.set(key, {
                        id: row.class_id,
                        school_id: row.school_id
                    });
                }
            }

            validClasses = {
                rows: [...uniqueAssignedClasses.values()]
            };

            const selectedClassIds = new Set(
                validClasses.rows.map(row => String(row.id))
            );

            if (
                classIds.some(id => !selectedClassIds.has(id))
            ) {
                throw new Error(
                    "One or more selected classes are not assigned to you."
                );
            }
        }

        /* ---------------------------------------------
           VALIDATE ADMINISTRATOR CLASSES
        --------------------------------------------- */

        else {
            validClasses = await client.query(
                `
                SELECT
                    c.id,
                    sl.school_id

                FROM classes c

                INNER JOIN school_levels sl
                    ON sl.level_id = c.level_id

                WHERE c.id = ANY($1::bigint[])
                  AND sl.school_id = ANY($2::bigint[])

                ORDER BY sl.school_id, c.class_name
                `,
                [
                    classIds,
                    schoolIds
                ]
            );

            const validClassIds = [
                ...new Set(
                    validClasses.rows.map(row => String(row.id))
                )
            ];

            if (validClassIds.length !== classIds.length) {
                throw new Error(
                    "One or more selected classes are not offered by the selected schools."
                );
            }
        }

        /* ---------------------------------------------
           VALIDATE SUBJECTS
        --------------------------------------------- */

        const validSubjects = await client.query(
            `
            SELECT id
            FROM subjects
            WHERE id = ANY($1::bigint[])
            `,
            [subjectIds]
        );

        if (validSubjects.rows.length !== subjectIds.length) {
            throw new Error(
                "One or more selected subjects are invalid."
            );
        }

        /* ---------------------------------------------
           FIND ACTIVE ACADEMIC YEAR AND TERM

           Kigali local date is used.
           Exactly one active period is required
           for each selected school.
        --------------------------------------------- */

        const activePeriodsResult = await client.query(
            `
            SELECT
                s.id AS school_id,
                s.school_name,
                ay.id AS academic_year_id,
                ay.year_name,
                tm.id AS term_id,
                tm.term_name,
                tm.term_number

            FROM schools s

            INNER JOIN academic_years ay
                ON ay.school_id = s.id

            INNER JOIN terms tm
                ON tm.school_id = s.id
               AND tm.academic_year_id = ay.id

            WHERE s.id = ANY($1::bigint[])

              AND (NOW() AT TIME ZONE 'Africa/Kigali')::date
                  BETWEEN ay.start_date AND ay.end_date

              AND (NOW() AT TIME ZONE 'Africa/Kigali')::date
                  BETWEEN tm.start_date AND tm.end_date

            ORDER BY
                s.school_name,
                ay.id,
                tm.term_number
            `,
            [schoolIds]
        );

        const periodsBySchool = new Map();

        for (const period of activePeriodsResult.rows) {
            const schoolId = String(period.school_id);

            if (!periodsBySchool.has(schoolId)) {
                periodsBySchool.set(schoolId, []);
            }

            periodsBySchool.get(schoolId).push(period);
        }

        const invalidPeriodSchools = [];

        for (const school of validSchools.rows) {
            const periods =
                periodsBySchool.get(String(school.id)) || [];

            if (periods.length !== 1) {
                invalidPeriodSchools.push(school.school_name);
            }
        }

        if (invalidPeriodSchools.length > 0) {
            throw new Error(
                "Cannot create this test. The following schools do not have exactly one active academic year and term: " +
                invalidPeriodSchools.join(", ") +
                ". Please check their academic calendar."
            );
        }

        const schoolAcademicPeriods = new Map();

        for (const period of activePeriodsResult.rows) {
            schoolAcademicPeriods.set(
                String(period.school_id),
                period
            );
        }

        /* ---------------------------------------------
           CREATE TEST

           Teacher:
           sector_id = NULL
           school_id = assigned school
           created_by = authenticated user
        --------------------------------------------- */

        const testResult = await client.query(
            `
            INSERT INTO tests (
                test_name,
                sector_id,
                school_id,
                created_by,
                status,
                closing_at
            )
            VALUES ($1, $2, $3, $4, 'draft', $5)
            RETURNING *
            `,
            [
                testName,

                auth.role === "sector_admin"
                    ? auth.sectorId
                    : null,

                ["school_admin", "dos", "teacher"].includes(auth.role)
                    ? schoolIds[0]
                    : null,

                auth.userId,
                closingAt
            ]
        );

        const test = testResult.rows[0];

        /* ---------------------------------------------
           INSERT TEST SCHOOLS AND PERIODS
        --------------------------------------------- */

        for (const schoolId of schoolIds) {
            const period = schoolAcademicPeriods.get(
                String(schoolId)
            );

            if (!period) {
                throw new Error(
                    "The active academic period could not be found for one of the selected schools."
                );
            }

            await client.query(
                `
                INSERT INTO test_schools (
                    test_id,
                    school_id,
                    academic_year_id,
                    term_id
                )
                VALUES ($1, $2, $3, $4)
                `,
                [
                    test.id,
                    schoolId,
                    period.academic_year_id,
                    period.term_id
                ]
            );
        }

        /* ---------------------------------------------
           INSERT TEST CLASSES
        --------------------------------------------- */

        for (const selectedClass of validClasses.rows) {
            await client.query(
                `
                INSERT INTO test_classes (
                    test_id,
                    school_id,
                    class_id
                )
                VALUES ($1, $2, $3)
                `,
                [
                    test.id,
                    selectedClass.school_id,
                    selectedClass.id
                ]
            );
        }

        /* ---------------------------------------------
           INSERT TEST SUBJECTS
        --------------------------------------------- */

        for (const subject of subjectMarks) {
            await client.query(
                `
                INSERT INTO test_subjects (
                    test_id,
                    subject_id,
                    total_marks
                )
                VALUES ($1, $2, $3)
                `,
                [
                    test.id,
                    subject.subject_id,
                    subject.total_marks
                ]
            );
        }

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Test created successfully.",
            test
        }, 201);

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Create test error:", error);

        const clientErrorMessages = [
            "Select at least one school.",
            "Select at least one class.",
            "Select at least one subject.",
            "Your account is not linked to a school.",
            "You do not have any teaching assignments.",
            "Your teaching assignments are linked to more than one school. Please contact your school administrator.",
            "One or more selected schools are invalid.",
            "One or more selected classes are not offered by the selected schools.",
            "One or more selected classes are not assigned to you.",
            "One or more selected subjects are invalid.",
            "You can only create tests for class and subject combinations assigned to you. Check your selected classes and subjects."
        ];

        const isClientError =
            clientErrorMessages.includes(error.message) ||
            error.message.startsWith("Cannot create this test.");

        return json({
            success: false,
            message: error.message || "Unable to create the test."
        }, isClientError ? 400 : 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
