/**
 * Vercel Serverless Function: api/generate.js
 * 
 * Vercel 및 Node.js 서버리스 환경 호환 handler.
 * 동적 모델 탐색(ListModels) 및 자동 폴백(Fallback) 탑재.
 */

const config = {
    api: {
        bodyParser: {
            sizeLimit: '4mb'
        }
    }
};

async function handler(req, res) {
    // CORS 헤더 설정
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'POST 요청만 지원합니다.' });
    }

    // Vercel 환경변수 GEMINI_API_KEY 검증
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ 
            success: false,
            error: 'Vercel 서버 환경변수(GEMINI_API_KEY)가 설정되지 않았습니다. Vercel 대시보드의 Settings > Environment Variables에서 GEMINI_API_KEY를 추가 후 Redeploy 해주세요.' 
        });
    }

    try {
        const { imageBase64, mimeType = 'image/jpeg', schoolInfo } = req.body || {};

        if (!imageBase64) {
            return res.status(400).json({ success: false, error: '분석할 이미지 데이터가 없습니다.' });
        }

        const systemInstruction = `당신은 학교 급식 및 음식 영양 분석을 전문으로 하는 국가 인증 AI 최고 영양사입니다.
제공된 식단/급식 사진을 정밀하게 분석하여 각 음식 메뉴별 상세 정보와 전체 칼로리, 3대 영양소(탄수화물, 단백질, 지방) 및 나트륨/당류 수치를 추정하세요.
학교 급식 영양 기준 및 교육부/식약처 영양 권장량을 바탕으로 식단의 영양 균형 점수(100점 만점)와 영양사 AI 특급 피드백을 제공합니다.`;

        const userPrompt = `이 사진은 급식 또는 음식 사진입니다.
${schoolInfo ? `[참고 정보] 학교/식단 정보: ${schoolInfo}` : ''}
사진에 나온 음식들을 식별하고 영양 성분을 분석하여 다음 JSON 구조로 응답하세요:
{
  "mealTitle": "식단 한 줄 요약",
  "totalCalories": 숫자(kcal),
  "nutritionScore": 숫자(0~100),
  "macronutrients": { "carbs": 숫자(g), "protein": 숫자(g), "fat": 숫자(g), "sodium": 숫자(mg), "sugar": 숫자(g) },
  "items": [ { "name": "음식명", "portion": "제공량", "calories": 숫자, "category": "분류" } ],
  "aiFeedback": { "summary": "총평", "warning": "주의점", "healthTip": "건강팁" }
}`;

        // 기본 페이로드
        const basePayload = {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: userPrompt },
                        {
                            inlineData: {
                                mimeType: mimeType,
                                data: imageBase64.replace(/^data:image\/\w+;base64,/, '')
                            }
                        }
                    ]
                }
            ],
            systemInstruction: {
                parts: [{ text: systemInstruction }]
            },
            generationConfig: {
                responseMimeType: "application/json"
            }
        };

        // 기본 정적 후보 모델 리스트
        let candidateModels = [
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-2.5-pro',
            'gemini-2.0-flash-lite',
            'gemini-1.5-flash',
            'gemini-1.5-pro'
        ];

        // Google AI API에서 현재 사용자의 API Key로 호출 가능한 최신 모델 목록을 실시간 동적 조회
        try {
            const listModelsUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
            const listRes = await fetch(listModelsUrl);
            if (listRes.ok) {
                const listData = await listRes.json();
                if (listData.models && Array.isArray(listData.models)) {
                    const validDynamicModels = listData.models
                        .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
                        .map(m => m.name.replace(/^models\//, ''));

                    if (validDynamicModels.length > 0) {
                        // 속도와 성능이 뛰어난 모델(flash, pro 계열) 순으로 자동 정렬
                        const priorityKeywords = ['2.5-flash', '2.0-flash', 'flash', '2.5-pro', 'pro'];
                        validDynamicModels.sort((a, b) => {
                            const indexA = priorityKeywords.findIndex(kw => a.includes(kw));
                            const indexB = priorityKeywords.findIndex(kw => b.includes(kw));
                            const rankA = indexA === -1 ? 99 : indexA;
                            const rankB = indexB === -1 ? 99 : indexB;
                            return rankA - rankB;
                        });
                        candidateModels = Array.from(new Set([...validDynamicModels, ...candidateModels]));
                    }
                }
            }
        } catch (listErr) {
            console.warn('동적 모델 목록 조회 실패, 기본 후보군 사용:', listErr.message);
        }

        let geminiRes = null;
        let lastErrorText = '';
        let modelAttemptErrors = [];

        for (const model of candidateModels) {
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            
            try {
                geminiRes = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': apiKey
                    },
                    body: JSON.stringify(basePayload)
                });

                if (geminiRes.ok) {
                    break; // 성공 시 탈출
                }

                const errText = await geminiRes.text();
                modelAttemptErrors.push(`[${model}] (${geminiRes.status}): ${errText}`);

                // API 키 자체의 권한/인증 오류(401, 403)인 경우 모델 변경이 의미없으므로 탈출
                if (geminiRes.status === 401 || geminiRes.status === 403) {
                    lastErrorText = errText;
                    break;
                }
            } catch (err) {
                modelAttemptErrors.push(`[${model}] Network Error: ${err.message}`);
                lastErrorText = err.message;
            }
        }

        if (!geminiRes || !geminiRes.ok) {
            console.error('Gemini API Error Log:', modelAttemptErrors);
            
            if (geminiRes?.status === 401 || geminiRes?.status === 403) {
                return res.status(geminiRes.status).json({
                    success: false,
                    error: `Gemini API 인증 오류 (${geminiRes.status}): Vercel 환경변수 GEMINI_API_KEY가 올바른지 확인해주세요.`
                });
            }

            const errorDetails = modelAttemptErrors.length > 0 ? modelAttemptErrors[modelAttemptErrors.length - 1] : lastErrorText;
            return res.status(geminiRes ? geminiRes.status : 500).json({ 
                success: false,
                error: `Gemini API 호출 실패: ${errorDetails || 'Google AI 서버와 통신할 수 없습니다.'}` 
            });
        }

        const data = await geminiRes.json();
        const rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!rawJsonText) {
            return res.status(500).json({ success: false, error: 'AI 식단 분석 응답 결과를 생성하지 못했습니다.' });
        }

        // 백틱 및 마크다운 코드블록 정밀 제거 후 안전한 JSON 파싱
        let parsedResult;
        try {
            const cleanJsonText = rawJsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
            parsedResult = JSON.parse(cleanJsonText);
        } catch (parseErr) {
            const jsonMatch = rawJsonText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                parsedResult = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('AI 응답 데이터를 규격화된 식단 정보로 파싱하지 못했습니다.');
            }
        }

        return res.status(200).json({
            success: true,
            data: parsedResult
        });

    } catch (error) {
        console.error('Server Internal Error:', error);
        return res.status(500).json({ 
            success: false,
            error: error.message || '서버 내부 처리 중 오류가 발생했습니다.' 
        });
    }
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = config;