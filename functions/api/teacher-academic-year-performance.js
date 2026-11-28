import { connectDB, authenticateRole, json } from "../_utils.js";

function validId(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function onRequestGet(context) {
    const auth = await authenticateRole(context, "teacher");
    if (auth.error) return auth.error;

    const academicYear = (new URL(context.request.url).searchParams.get("academic_year") || "").trim();
    if (academicYear.length > 100) return json({ success: false, message: "Invalid academic year." }, 400);

    const schoolId = validId(auth.schoolId);
    const userId = validId(auth.userId);
    if (!schoolId || !userId) return json({ success: false, message: "Your account is not linked to a school." }, 403);

    let client;
    try {
        client = await connectDB(context);

        const teacherResult = await client.query(
            `SELECT t.id AS teacher_id, u.full_name, s.school_name
             FROM teachers t
             INNER JOIN users u ON u.id = t.user_id AND u.school_id = t.school_id AND u.role = 'teacher'
             INNER JOIN schools s ON s.id = t.school_id
             WHERE t.user_id = $1 AND t.school_id = $2
             LIMIT 1`,
            [userId, schoolId]
        );
        if (!teacherResult.rowCount) return json({ success: false, message: "Your teacher profile could not be found." }, 404);
        const teacher = teacherResult.rows[0];
        const teacherId = Number(teacher.teacher_id);

        const yearsResult = await client.query(
            `SELECT ay.year_name, MIN(ay.start_date) AS start_date, MAX(ay.end_date) AS end_date,
                    COUNT(DISTINCT t.id) FILTER (WHERE EXISTS (
                        SELECT 1
                        FROM test_classes tc_count
                        INNER JOIN test_subjects ts_count ON ts_count.test_id = tc_count.test_id
                        INNER JOIN teacher_assignments ta_count
                          ON ta_count.teacher_id = $1
                         AND ta_count.school_id = ay.school_id
                         AND ta_count.class_id = tc_count.class_id
                         AND ta_count.subject_id = ts_count.subject_id
                         AND (ta_count.academic_year_id IS NULL OR ta_count.academic_year_id = ay.id)
                        WHERE tc_count.test_id = t.id AND tc_count.school_id = ay.school_id
                    )) AS total_tests
             FROM academic_years ay
             INNER JOIN teacher_assignments ta ON ta.school_id = ay.school_id
               AND ta.teacher_id = $1
               AND (ta.academic_year_id IS NULL OR ta.academic_year_id = ay.id)
             LEFT JOIN test_schools ts ON ts.school_id = ay.school_id AND ts.academic_year_id = ay.id
             LEFT JOIN tests t ON t.id = ts.test_id
             WHERE ay.school_id = $2
             GROUP BY ay.year_name
             ORDER BY MAX(ay.start_date) DESC NULLS LAST, ay.year_name DESC`,
            [teacherId, schoolId]
        );
        const academicYears = yearsResult.rows.map(r => ({
            name: r.year_name, start_date: r.start_date, end_date: r.end_date,
            total_tests: Number(r.total_tests || 0), total_schools: 1
        }));

        if (!academicYear) {
            return json({
                success: true,
                user: { role: "teacher", schoolId: String(schoolId), teacherId: String(teacherId), name: teacher.full_name, schoolName: teacher.school_name },
                academic_years: academicYears,
                schools: [{ id: String(schoolId), name: teacher.school_name }],
                classes: [], subjects: [], tests: [], rows: []
            });
        }

        const assignmentResult = await client.query(
            `SELECT DISTINCT c.id AS class_id, c.class_name, sub.id AS subject_id, sub.subject_name
             FROM teacher_assignments ta
             INNER JOIN classes c ON c.id = ta.class_id
             INNER JOIN subjects sub ON sub.id = ta.subject_id
             INNER JOIN academic_years ay ON ay.school_id = ta.school_id AND ay.year_name = $3
               AND (ta.academic_year_id IS NULL OR ta.academic_year_id = ay.id)
             WHERE ta.teacher_id = $1 AND ta.school_id = $2
             ORDER BY c.class_name, sub.subject_name`,
            [teacherId, schoolId, academicYear]
        );
        const classMap = new Map();
        const subjects = [];
        for (const r of assignmentResult.rows) {
            classMap.set(String(r.class_id), r.class_name);
            subjects.push({ id: String(r.subject_id), name: r.subject_name, class_id: String(r.class_id) });
        }
        const classes = [...classMap].map(([id, name]) => ({ id, name }));

        const result = await client.query(
            `WITH active_enrollments AS (
                SELECT DISTINCT ON (se.student_id, se.school_id, se.class_id, se.academic_year_id, se.term_id)
                    se.student_id, se.school_id, se.class_id, se.academic_year_id, se.term_id, se.subclass_id
                FROM student_enrollments se
                WHERE LOWER(TRIM(se.status)) = 'active'
                ORDER BY se.student_id, se.school_id, se.class_id, se.academic_year_id, se.term_id,
                         se.updated_at DESC NULLS LAST, se.id DESC
             )
             SELECT t.id AS test_id, t.test_name, t.status AS test_status, t.created_at AS test_created_at,
                    ts.academic_year_id, ts.term_id, ay.year_name, tm.term_number, tm.term_name,
                    sch.id AS school_id, sch.school_name,
                    c.id AS class_id, c.class_name, c.level_id,
                    sub.id AS subject_id, sub.subject_name, sub.subject_code, test_subject.total_marks,
                    st.id AS student_id, st.full_name AS student_name, st.student_code, st.gender,
                    enrollment.subclass_id, scs.subclass_name, latest_mark.score
             FROM tests t
             INNER JOIN test_schools ts ON ts.test_id = t.id
             INNER JOIN schools sch ON sch.id = ts.school_id
             INNER JOIN academic_years ay ON ay.id = ts.academic_year_id AND ay.school_id = ts.school_id
             INNER JOIN terms tm ON tm.id = ts.term_id AND tm.academic_year_id = ts.academic_year_id AND tm.school_id = ts.school_id
             INNER JOIN test_classes tc ON tc.test_id = t.id AND tc.school_id = ts.school_id
             INNER JOIN classes c ON c.id = tc.class_id
             INNER JOIN test_subjects test_subject ON test_subject.test_id = t.id
             INNER JOIN subjects sub ON sub.id = test_subject.subject_id
             LEFT JOIN active_enrollments enrollment ON enrollment.school_id = ts.school_id
                AND enrollment.class_id = tc.class_id AND enrollment.academic_year_id = ts.academic_year_id
                AND enrollment.term_id = ts.term_id
             LEFT JOIN students st ON st.id = enrollment.student_id AND st.school_id = ts.school_id
                AND LOWER(TRIM(st.status)) = 'active'
             LEFT JOIN school_class_subclasses scs ON scs.id = enrollment.subclass_id
                AND scs.school_id = enrollment.school_id AND scs.academic_year_id = enrollment.academic_year_id
                AND scs.class_id = enrollment.class_id
             LEFT JOIN LATERAL (
                SELECT mk.score FROM marks mk
                WHERE mk.test_id = t.id AND mk.student_id = st.id AND mk.class_id = tc.class_id AND mk.subject_id = sub.id
                ORDER BY mk.updated_at DESC NULLS LAST, mk.id DESC LIMIT 1
             ) latest_mark ON TRUE
             WHERE ts.school_id = $1 AND ay.year_name = $2
               AND EXISTS (
                   SELECT 1 FROM teacher_assignments ta
                   WHERE ta.teacher_id = $3 AND ta.school_id = ts.school_id
                     AND ta.class_id = tc.class_id AND ta.subject_id = sub.id
                     AND (ta.academic_year_id IS NULL OR ta.academic_year_id = ts.academic_year_id)
                     AND (ta.subclass_id IS NULL OR ta.subclass_id = enrollment.subclass_id)
               )
             ORDER BY t.created_at ASC NULLS LAST, t.id ASC, c.class_name, st.full_name, sub.subject_name`,
            [schoolId, academicYear, teacherId]
        );

        const testsMap = new Map();
        for (const r of result.rows) {
            const id = String(r.test_id);
            if (!testsMap.has(id)) testsMap.set(id, {
                id, name: r.test_name, status: r.test_status, created_at: r.test_created_at,
                term_number: Number(r.term_number), term_name: r.term_name, schools: new Set()
            });
            testsMap.get(id).schools.add(String(r.school_id));
        }
        const rows = result.rows.map(r => ({
            test_id: String(r.test_id), test_name: r.test_name, test_status: r.test_status,
            test_created_at: r.test_created_at, term_number: Number(r.term_number), term_name: r.term_name,
            school_id: String(r.school_id), school_name: r.school_name,
            class_id: String(r.class_id), class_name: r.class_name, class_level: Number(r.level_id),
            subject_id: String(r.subject_id), subject_name: r.subject_name, subject_code: r.subject_code,
            maximum_mark: Number(r.total_marks),
            student_id: r.student_id === null ? null : String(r.student_id),
            student_name: r.student_name, student_code: r.student_code, gender: r.gender,
            subclass_id: r.subclass_id === null ? null : String(r.subclass_id), subclass_name: r.subclass_name,
            score: r.score === null ? null : Number(r.score)
        }));
        const tests = [...testsMap.values()].map(t => ({
            id: t.id, name: t.name, status: t.status, created_at: t.created_at,
            term_number: t.term_number, term_name: t.term_name, total_schools: t.schools.size
        }));

        return json({
            success: true,
            user: { role: "teacher", schoolId: String(schoolId), teacherId: String(teacherId), name: teacher.full_name, schoolName: teacher.school_name },
            academic_years: academicYears,
            schools: [{ id: String(schoolId), name: teacher.school_name }],
            selected_academic_year: academicYear, classes, subjects, tests, rows
        });
    } catch (error) {
        console.error("Teacher Academic Year Performance API error:", error);
        return json({ success: false, message: "Unable to load your academic-year performance data." }, 500);
    } finally {
        if (client) await client.end().catch(() => {});
    }
}
