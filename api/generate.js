/**
 * Vercel Serverless Function: api/generate.js
 * 
 * Vercel 및 Node.js 서버리스 환경 호환 handler.
 * 최신 Gemini API 모델 지원 및 모델 미지원 시 자동 폴백(Fallback) 탑재.
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
사진에 나온 음식들을 식별하고 영양 성분을 분석하여 정의된 JSON 형식으로만 정확히 응답해주세요.`;

        const payload = {
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
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        mealTitle: { type: "STRING", description: "식단 한 줄 요약 메인 이름 (예: 매콤 제육볶음과 찰보리밥 급식)" },
                        totalCalories: { type: "NUMBER", description: "총 예상 칼로리 (kcal)" },
                        nutritionScore: { type: "NUMBER", description: "영양 균형 점수 (0~100)" },
                        macronutrients: {
                            type: "OBJECT",
                            properties: {
                                carbs: { type: "NUMBER", description: "탄수화물 (g)" },
                                protein: { type: "NUMBER", description: "단백질 (g)" },
                                fat: { type: "NUMBER", description: "지방 (g)" },
                                sodium: { type: "NUMBER", description: "나트륨 (mg)" },
                                sugar: { type: "NUMBER", description: "당류 (g)" }
                            },
                            required: ["carbs", "protein", "fat", "sodium", "sugar"]
                        },
                        items: {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    name: { type: "STRING", description: "음식/메뉴 이름" },
                                    portion: { type: "STRING", description: "추정 1회 제공량 (예: 1공기, 150g, 1대)" },
                                    calories: { type: "NUMBER", description: "해당 음식 칼로리 (kcal)" },
                                    category: { type: "STRING", description: "분류 (주식, 국/찌개, 메인반찬, 찬류, 후식 등)" }
                                },
                                required: ["name", "portion", "calories", "category"]
                            }
                        },
                        aiFeedback: {
                            type: "OBJECT",
                            properties: {
                                summary: { type: "STRING", description: "영양 총평 및 잘된 점" },
                                warning: { type: "STRING", description: "주의점 및 섭취 팁 (예: 나트륨 과다 주의, 단백질 보충 권장 등)" },
                                healthTip: { type: "STRING", description: "학생/사용자를 위한 맞춤 건강 조언" }
                            },
                            required: ["summary", "warning", "healthTip"]
                        }
                    },
                    required: ["mealTitle", "totalCalories", "nutritionScore", "macronutrients", "items", "aiFeedback"]
                }
            }
        };

        // 지원 종료/미지원 모델(gemini-2.5-flash)을 제거하고 현재 정식 호환되는 모델로 업데이트
        const candidateModels = [
            'gemini-1.5-flash',
            'gemini-1.5-flash-latest',
            'gemini-1.5-pro',
            'gemini-2.0-flash-exp'
        ];

        let geminiRes = null;
        let lastErrorText = '';

        for (const model of candidateModels) {
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            
            try {
                geminiRes = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': apiKey
                    },
                    body: JSON.stringify(payload)
                });

                if (geminiRes.ok) {
                    break; // 성공 시 루프 탈출
                }

                lastErrorText = await geminiRes.text();
                // API 키 자체의 권한/인증 오류(401, 403)인 경우 모델 변경이 의미없으므로 탈출
                if (geminiRes.status === 401 || geminiRes.status === 403) {
                    break;
                }
            } catch (err) {
                lastErrorText = err.message;
            }
        }

        if (!geminiRes || !geminiRes.ok) {
            console.error('Gemini API Error Response:', lastErrorText);
            
            if (geminiRes?.status === 401 || geminiRes?.status === 403) {
                return res.status(geminiRes.status).json({
                    success: false,
                    error: `Gemini API 인증 오류 (${geminiRes.status}): Vercel 환경변수 GEMINI_API_KEY가 유효한지 확인해 주세요.`
                });
            }

            return res.status(geminiRes ? geminiRes.status : 500).json({ 
                success: false,
                error: `Gemini API 호출 실패: ${lastErrorText || 'Google AI 서버와 통신할 수 없습니다.'}` 
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