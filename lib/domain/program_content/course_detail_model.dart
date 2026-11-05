
class CourseQuizQuestionModel {
  const CourseQuizQuestionModel({
    required this.question,
    required this.options,
    required this.answerKey,
    this.hint,
    this.explanation,
  });

  final String question;
  final Map<String, String> options;
  final String answerKey;
  final String? hint;
  final String? explanation;

  factory CourseQuizQuestionModel.fromJson(Map<String, dynamic> json) =>
      CourseQuizQuestionModel(
        question: json['q'] as String? ?? '',
        options: json['opts'] is Map
            ? Map<String, String>.from(
                (json['opts'] as Map).map(
                  (k, v) => MapEntry(k.toString(), v.toString()),
                ),
              )
            : const {},
        answerKey: json['ans']?.toString() ?? '',
        hint: json['hnt'] as String?,
        explanation: json['exp'] as String?,
      );

  static List<CourseQuizQuestionModel> listFromJson(dynamic raw) {
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map(
          (m) => CourseQuizQuestionModel.fromJson(Map<String, dynamic>.from(m)),
        )
        .toList(growable: false);
  }
}

class CourseQuizModel {
  const CourseQuizModel({
    required this.id,
    required this.name,
    required this.questions,
  });

  final String id;
  final String name;
  final List<CourseQuizQuestionModel> questions;

  factory CourseQuizModel.fromJson(Map<String, dynamic> json) =>
      CourseQuizModel(
        id: json['id']?.toString() ?? '',
        name: json['nm'] as String? ?? '',
        questions: CourseQuizQuestionModel.listFromJson(json['qs']),
      );
}

class CourseVideoModel {
  const CourseVideoModel({
    required this.id,
    required this.name,
    required this.description,
    required this.youtubeId,
    required this.points,
    this.durationLabel,
    this.postQuiz,
  });

  final String id;
  final String name;
  final String description;
  final String youtubeId;
  final int points;
  final String? durationLabel;
  final CourseQuizModel? postQuiz;

  static const int _defaultVideoPoints = 10;

  factory CourseVideoModel.fromJson(Map<String, dynamic> json) =>
      CourseVideoModel(
        id: json['id']?.toString() ?? '',
        name: json['nm'] as String? ?? '',
        description: json['desc'] as String? ?? '',
        youtubeId: json['yt'] as String? ?? '',
        points:
            (json['pts'] as num?)?.toInt() ??
            (json['points'] as num?)?.toInt() ??
            _defaultVideoPoints,
        durationLabel: json['dur'] as String?,
        postQuiz: json['pq'] is Map
            ? CourseQuizModel.fromJson(
                Map<String, dynamic>.from(json['pq'] as Map),
              )
            : null,
      );

  static List<CourseVideoModel> listFromJson(dynamic raw) {
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((m) => CourseVideoModel.fromJson(Map<String, dynamic>.from(m)))
        .toList(growable: false);
  }
}

class CourseAssignmentStepModel {
  const CourseAssignmentStepModel({
    required this.step,
    required this.label,
    required this.subTypes,
    this.guidedText,
    required this.unguidedText,
    this.validCriteria,
    this.invalidCriteria,
  });

  final int step;
  final String label;
  final String subTypes;
  final String? guidedText;
  final String unguidedText;
  final String? validCriteria;
  final String? invalidCriteria;

  factory CourseAssignmentStepModel.fromJson(Map<String, dynamic> json) =>
      CourseAssignmentStepModel(
        step: (json['step'] as num?)?.toInt() ?? 0,
        label: json['label'] as String? ?? '',
        subTypes: json['sub_types'] as String? ?? '',
        guidedText: json['guided_text'] as String?,
        unguidedText: json['unguided_text'] as String? ?? '',
        validCriteria: json['valid_criteria'] as String?,
        invalidCriteria: json['invalid_criteria'] as String?,
      );

  static List<CourseAssignmentStepModel> listFromJson(dynamic raw) {
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map(
          (m) =>
              CourseAssignmentStepModel.fromJson(Map<String, dynamic>.from(m)),
        )
        .toList(growable: false);
  }
}

class CourseAssignmentModel {
  const CourseAssignmentModel({
    required this.id,
    required this.sequence,
    required this.name,
    required this.description,
    required this.type,
    required this.difficulty,
    required this.subTypes,
    required this.unguidedText,
    required this.steps,
  });

  final String id;
  final int sequence;
  final String name;
  final String description;
  final String type;
  final String difficulty;
  final String subTypes;
  final String unguidedText;
  final List<CourseAssignmentStepModel> steps;

  factory CourseAssignmentModel.fromJson(Map<String, dynamic> json) {
    final steps = CourseAssignmentStepModel.listFromJson(json['steps']);
    final subTypes = json['sub_types'] as String? ?? '';
    final unguidedText = json['unguided_text'] as String? ?? '';

    return CourseAssignmentModel(
      id: json['id']?.toString() ?? '',
      sequence: (json['seq'] as num?)?.toInt() ?? 0,
      name: json['nm'] as String? ?? '',
      description: json['desc'] as String? ?? '',
      type: json['type'] as String? ?? '',
      difficulty: json['diff'] as String? ?? '',
      subTypes: subTypes,
      unguidedText: unguidedText,
      steps: steps.isNotEmpty
          ? steps
          : (subTypes.isEmpty && unguidedText.isEmpty
                ? const []
                : [
                    CourseAssignmentStepModel(
                      step: 1,
                      label: '',
                      subTypes: subTypes,
                      guidedText: null,
                      unguidedText: unguidedText,
                      validCriteria: null,
                      invalidCriteria: null,
                    ),
                  ]),
    );
  }

  static List<CourseAssignmentModel> listFromJson(dynamic raw) {
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map(
          (m) => CourseAssignmentModel.fromJson(Map<String, dynamic>.from(m)),
        )
        .toList(growable: false);
  }
}

class CourseUnitModel {
  const CourseUnitModel({
    required this.id,
    required this.order,
    required this.name,
    required this.description,
    required this.requiredComponents,
    required this.difficulty,
    required this.xp,
    required this.videos,
    this.quiz,
    required this.assignments,
  });

  final String id;
  final int order;
  final String name;
  final String description;
  final String requiredComponents;
  final String difficulty;
  final int xp;
  final List<CourseVideoModel> videos;
  final CourseQuizModel? quiz;
  final List<CourseAssignmentModel> assignments;

  static int _computeXp(List<CourseVideoModel> videos) {
    if (videos.isEmpty) return CourseVideoModel._defaultVideoPoints;
    return videos.first.points;
  }

  factory CourseUnitModel.fromJson(Map<String, dynamic> json) {
    final videos = CourseVideoModel.listFromJson(
      json['video'] ?? json['vids'],
    );
    final quiz = json['quiz'] is Map
        ? CourseQuizModel.fromJson(Map<String, dynamic>.from(json['quiz'] as Map))
        : null;

    return CourseUnitModel(
      id: json['id']?.toString() ?? '',
      order: (json['ord'] as num?)?.toInt() ?? 0,
      name: json['nm'] as String? ?? '',
      description: json['desc'] as String? ?? '',
      requiredComponents: json['rwc'] as String? ?? '',
      difficulty: json['diff'] as String? ?? '',
      xp: (json['xp'] as num?)?.toInt() ?? _computeXp(videos),
      videos: videos,
      quiz: quiz,
      assignments: CourseAssignmentModel.listFromJson(
        json['assign'] ?? json['assigns'],
      ),
    );
  }

  static List<CourseUnitModel> listFromJson(dynamic raw) {
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((m) => CourseUnitModel.fromJson(Map<String, dynamic>.from(m)))
        .toList(growable: false);
  }
}

class CourseDetailModel {
  const CourseDetailModel({
    required this.id,
    required this.name,
    required this.level,
    required this.vertical,
    required this.kitLess,
    required this.description,
    required this.units,
  });

  final String id;
  final String name;
  final String level;
  final String vertical;
  final bool kitLess;
  final String description;
  final List<CourseUnitModel> units;

  factory CourseDetailModel.fromJson(Map<String, dynamic> json) =>
      CourseDetailModel(
        id: json['id'] as String? ?? '',
        name: json['nm'] as String? ?? '',
        level: json['lvl'] as String? ?? '',
        vertical: json['vrt'] as String? ?? '',
        kitLess: json['kit_less'] as bool? ?? false,
        description: json['desc'] as String? ?? '',
        units: CourseUnitModel.listFromJson(json['units']),
      );
}