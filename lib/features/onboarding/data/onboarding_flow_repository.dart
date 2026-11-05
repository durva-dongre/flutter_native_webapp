import 'dart:convert';

import 'package:flutter/services.dart';

import '../../../core/constants/app_constants.dart';
import '../models/onboarding_flow_step.dart';

class OnboardingFlowRepository {
  const OnboardingFlowRepository();

  Future<Map<String, OnboardingFlowStep>> load({
    String languageCode = AppConstants.defaultLanguageCode,
  }) async {
    final assetPath = AppConstants.flowAssetPath('onboarding', languageCode);
    final source = await rootBundle.loadString(assetPath);
    final decoded = jsonDecode(source) as Map<String, dynamic>;
    final steps = (decoded['steps'] as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .map(OnboardingFlowStep.fromJson);
    return {for (final step in steps) step.id: step};
  }
}