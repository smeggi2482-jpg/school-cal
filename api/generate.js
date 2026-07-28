/**
 * Vercel Serverless Function: api/generate.js
 * 
 * Vercel 및 Node.js 서버리스 환경 호환 handler.
 * 최신 Gemini API 모델 지원 및 429 Quota 에러 정제/폴백 탑재.
 */

const config = {
    api: {
        bodyParser: {
            sizeLimit: '4mb'
        }
    }
};

/* STREAMING_CHUNK:Defining main request handler... */
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
            error: 'Vercel 환경변수(GEMINI_API_KEY)가 설정되지 않았습니다. Vercel 대시보드 Settings > Environment Variables에서 GEMINI_API_KEY를 설정해 주세요.' 
        });
    }

    /* STREAMING_CHUNK:Building system instruction and JSON schema payload... */
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

        /* STREAMING_CHUNK:Executing model sequence with error handling... */
        const candidateModels = [
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-1.5-flash'
        ];

        let geminiRes = null;
        let lastErrorText = '';
        let isQuotaExceeded = false;

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
                    break;
                }

                lastErrorText = await geminiRes.text();

                if (geminiRes.status === 429 || lastErrorText.includes('RESOURCE_EXHAUSTED') || lastErrorText.includes('Quota exceeded')) {
                    isQuotaExceeded = true;
                }

                // 404가 아니고 429도 아닐 경우 (인증 실패 401/403 등)
                if (geminiRes.status !== 404 && geminiRes.status !== 429) {
                    break;
                }
            } catch (err) {
                lastErrorText = err.message;
            }
        }

        /* STREAMING_CHUNK:Sanitizing error response for client... */
        if (!geminiRes || !geminiRes.ok) {
            console.error('Gemini API Response Failed:', lastErrorText);

            if (isQuotaExceeded || geminiRes?.status === 429) {
                return res.status(429).json({
                    success: false,
                    error: 'Gemini API 무료 사용량 한도(Quota)가 초과되었습니다. 무료 요금제 분당 제한으로 인해 약 20~30초 후 [AI 식단 칼로리 분석 시작]을 다시 클릭해 주세요.'
                });
            }

            if (geminiRes?.status === 400 || geminiRes?.status === 403 || geminiRes?.status === 401) {
                return res.status(geminiRes.status).json({
                    success: false,
                    error: `Gemini API 인증 오류 (${geminiRes.status}): Vercel 환경변수 GEMINI_API_KEY가 유효한지 Google AI Studio에서 확인해 주세요.`
                });
            }

            return res.status(geminiRes ? geminiRes.status : 500).json({ 
                success: false,
                error: 'Gemini AI 서버 처리 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' 
            });
        }

        const data = await geminiRes.json();
        const rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!rawJsonText) {
            return res.status(500).json({ success: false, error: 'AI 식단 분석 응답 결과를 생성하지 못했습니다.' });
        }

        const parsedResult = JSON.parse(rawJsonText);

        return res.status(200).json({
            success: true,
            data: parsedResult
        });

    } catch (error) {
        console.error('Server Internal Error:', error);
        return res.status(500).json({ 
            success: false,
            error: '서버 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' 
        });
    }
}

module.exports = handler;
module.exports.default = handler;
module.exports.config = config;
```eof

/* STREAMING_CHUNK:Creating responsive HTML layout and client-side error formatter... */

html:AI 음식 칼로리 도우미:index.html
```html
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI 급식 & 음식 칼로리 영양 도우미</title>
    <!-- Tailwind CSS CDN -->
    <script src="https://cdn.tailwindcss.com"></script>
    <!-- FontAwesome Icons -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <!-- Google Font Noto Sans KR -->
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['Noto Sans KR', 'sans-serif'],
                    },
                    colors: {
                        brand: {
                            50: '#f0fdf4',
                            100: '#dcfce7',
                            500: '#22c55e',
                            600: '#16a34a',
                            700: '#15803d',
                        }
                    }
                }
            }
        }
    </script>
</head>
<body class="bg-slate-50 text-slate-800 font-sans min-h-screen flex flex-col antialiased">

    <!-- Header -->
    <header class="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
        <div class="max-w-5xl mx-auto px-4 py-3.5 flex items-center justify-between">
            <div class="flex items-center space-x-3">
                <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-green-500 to-emerald-400 flex items-center justify-center text-white shadow-md shadow-green-200">
                    <i class="fa-solid font-bold fa-utensils text-lg"></i>
                </div>
                <div>
                    <h1 class="font-bold text-slate-900 text-lg sm:text-xl leading-tight">AI 급식 & 칼로리 도우미</h1>
                    <p class="text-xs text-slate-500 hidden sm:block">스마트 급식 사진 분석 및 맞춤형 영양 케어</p>
                </div>
            </div>
            <div class="flex items-center space-x-2">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                    <span class="w-2 h-2 mr-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    Gemini AI 가동중
                </span>
            </div>
        </div>
    </header>

    <!-- Custom Toast Notification Box -->
    <div id="toastNotification" class="fixed top-16 left-1/2 -translate-x-1/2 z-50 hidden max-w-lg w-full px-4 transition-all duration-300">
        <div id="toastBox" class="bg-slate-900 text-white text-xs sm:text-sm font-medium px-4 py-3 rounded-xl shadow-2xl flex items-start justify-between space-x-3 border border-slate-700 max-h-48 overflow-y-auto">
            <div class="flex items-start space-x-2.5">
                <i class="fa-solid fa-circle-exclamation text-amber-400 text-lg mt-0.5 flex-shrink-0"></i>
                <span id="toastMessage" class="leading-relaxed break-words">오류 메시지가 표시됩니다.</span>
            </div>
            <button onclick="hideToast()" class="text-slate-400 hover:text-white p-1 flex-shrink-0">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    </div>

    <!-- STREAMING_CHUNK:Main application layout... -->
    <main class="flex-grow max-w-5xl w-full mx-auto px-4 py-6 space-y-6">

        <!-- Info / Helper Banner -->
        <div class="bg-gradient-to-r from-emerald-600 to-teal-700 rounded-2xl p-5 text-white shadow-lg shadow-emerald-900/10 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div class="space-y-1">
                <div class="flex items-center space-x-2">
                    <span class="bg-white/20 text-xs px-2.5 py-0.5 rounded-full font-medium backdrop-blur-sm">교육정보 개방포털 연동 지원</span>
                    <span class="bg-emerald-400/30 text-xs px-2.5 py-0.5 rounded-full font-medium">급식/음식 사진 인식</span>
                </div>
                <h2 class="text-xl font-bold">급식 사진 한 장으로 완벽한 칼로리 & 영양 다이어리 작성!</h2>
                <p class="text-emerald-100 text-sm">밥, 국, 반찬 식단을 자동으로 분류하고, 나트륨 및 당류 수치와 영양사 AI의 어드바이스를 확인하세요.</p>
            </div>
            <div class="w-full md:w-auto flex-shrink-0">
                <button onclick="openSchoolModal()" class="w-full md:w-auto px-4 py-2.5 bg-white text-emerald-800 hover:bg-emerald-700 hover:text-white rounded-xl font-semibold text-sm transition flex items-center justify-center space-x-2 shadow">
                    <i class="fa-solid fa-school"></i>
                    <span>학교 급식 정보 입력 (선택)</span>
                </button>
            </div>
        </div>

        <!-- Main Workspace Grid -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">

            <!-- Upload Column -->
            <div class="lg:col-span-5 space-y-4">
                <div class="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-sm flex flex-col h-full">
                    <h3 class="font-bold text-slate-900 text-base mb-3 flex items-center">
                        <i class="fa-solid fa-camera text-emerald-600 mr-2"></i>
                        급식 / 음식 사진 업로드
                    </h3>

                    <!-- Upload Area Box -->
                    <div id="dropZone" class="relative flex-grow min-h-[260px] border-2 border-dashed border-slate-300 hover:border-emerald-500 rounded-xl bg-slate-50 transition duration-200 flex flex-col items-center justify-center p-4 cursor-pointer group">
                        <input type="file" id="imageInput" accept="image/*" class="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" onchange="handleFileSelect(event)">
                        
                        <!-- Placeholder State -->
                        <div id="uploadPlaceholder" class="text-center space-y-3 pointer-events-none">
                            <div class="w-14 h-14 mx-auto rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center group-hover:scale-110 transition">
                                <i class="fa-solid fa-cloud-arrow-up text-2xl"></i>
                            </div>
                            <div>
                                <p class="text-sm font-semibold text-slate-700">사진을 클릭하거나 여기로 드래그하세요</p>
                                <p class="text-xs text-slate-400 mt-1">자동 이미지 최적화 적용 (스마트폰 지원)</p>
                            </div>
                            <span class="inline-block px-3 py-1 bg-white border border-slate-200 rounded-lg text-xs text-slate-600 shadow-sm">
                                <i class="fa-solid fa-compress mr-1 text-emerald-500"></i> 고화질 리사이징 자동 적용
                            </span>
                        </div>

                        <!-- Image Preview State -->
                        <div id="previewContainer" class="hidden w-full h-full relative group-hover:opacity-95">
                            <img id="imagePreview" src="" alt="식단 사진 미리보기" class="w-full h-64 object-cover rounded-lg shadow-inner">
                            <button type="button" onclick="resetImage(event)" class="absolute top-2 right-2 z-20 w-8 h-8 bg-slate-900/70 hover:bg-red-600 text-white rounded-full flex items-center justify-center transition shadow">
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                        </div>
                    </div>

                    <!-- Selected School Info Tag -->
                    <div id="schoolInfoDisplay" class="hidden mt-3 p-2.5 bg-slate-100 rounded-lg text-xs text-slate-600 flex items-center justify-between">
                        <span class="font-medium text-emerald-700 truncate" id="schoolTagText">학교 정보 설정됨</span>
                        <button onclick="clearSchoolInfo()" class="text-slate-400 hover:text-red-500"><i class="fa-solid fa-circle-xmark"></i></button>
                    </div>

                    <!-- Analyze Submit Button -->
                    <button id="analyzeBtn" onclick="analyzeMealImage()" disabled class="mt-4 w-full py-3.5 px-4 bg-slate-300 text-slate-500 font-bold rounded-xl shadow transition duration-200 flex items-center justify-center space-x-2 disabled:cursor-not-allowed">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                        <span>AI 식단 칼로리 분석 시작</span>
                    </button>
                </div>
            </div>

            <!-- Result Column -->
            <div class="lg:col-span-7">
                
                <!-- Empty Initial State -->
                <div id="emptyResultState" class="bg-white rounded-2xl p-8 border border-slate-200/80 shadow-sm text-center flex flex-col items-center justify-center min-h-[380px] h-full space-y-3">
                    <div class="w-16 h-16 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center text-2xl">
                        <i class="fa-solid fa-plate-wheat"></i>
                    </div>
                    <h4 class="font-bold text-slate-700 text-base">급식 사진을 올리고 분석을 진행하세요</h4>
                    <p class="text-xs text-slate-400 max-w-xs leading-relaxed">
                        Gemini Vision AI가 식단의 칼로리, 영양소 분량, 나트륨 비율 및 개별 메뉴 성분을 정밀하게 분석합니다.
                    </p>
                </div>

                <!-- Loading Spinner State -->
                <div id="loadingState" class="hidden bg-white rounded-2xl p-8 border border-slate-200/80 shadow-sm text-center flex flex-col items-center justify-center min-h-[380px] h-full space-y-4">
                    <div class="relative w-16 h-16">
                        <div class="w-16 h-16 border-4 border-emerald-100 border-t-emerald-500 rounded-full animate-spin"></div>
                        <i class="fa-solid fa-utensils text-emerald-500 absolute inset-0 m-auto w-fit h-fit text-sm"></i>
                    </div>
                    <div>
                        <h4 class="font-bold text-slate-800 text-base">AI 영양사가 급식을 정밀 분석 중입니다...</h4>
                        <p class="text-xs text-slate-500 mt-1">메뉴 식별, 칼로리 계산 및 영양 균형 점수를 매기고 있습니다.</p>
                    </div>
                </div>

                <!-- Analysis Result Detail Panel -->
                <div id="resultContent" class="hidden space-y-5">

                    <!-- Title & Calorie Overview Card -->
                    <div class="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-sm space-y-4">
                        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3">
                            <div>
                                <span class="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">식단 분석 결과</span>
                                <h3 id="resMealTitle" class="text-lg font-bold text-slate-900 mt-1">매콤 제육볶음 급식</h3>
                            </div>
                            <div class="flex items-center space-x-2">
                                <div class="text-right">
                                    <div class="text-xs text-slate-400">영양 균형 점수</div>
                                    <div id="resScore" class="text-xl font-black text-emerald-600">88점</div>
                                </div>
                            </div>
                        </div>

                        <!-- Calorie & Nutrients Metrics -->
                        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div class="bg-emerald-50/60 border border-emerald-100 p-3 rounded-xl">
                                <p class="text-xs text-emerald-700 font-medium">총 칼로리</p>
                                <p class="text-xl font-black text-emerald-900 mt-0.5"><span id="resCalories">0</span> <span class="text-xs font-normal">kcal</span></p>
                            </div>
                            <div class="bg-slate-50 border border-slate-100 p-3 rounded-xl">
                                <p class="text-xs text-slate-500 font-medium">탄수화물</p>
                                <p class="text-lg font-bold text-slate-800 mt-0.5"><span id="resCarbs">0</span> <span class="text-xs font-normal">g</span></p>
                            </div>
                            <div class="bg-slate-50 border border-slate-100 p-3 rounded-xl">
                                <p class="text-xs text-slate-500 font-medium">단백질</p>
                                <p class="text-lg font-bold text-slate-800 mt-0.5"><span id="resProtein">0</span> <span class="text-xs font-normal">g</span></p>
                            </div>
                            <div class="bg-slate-50 border border-slate-100 p-3 rounded-xl">
                                <p class="text-xs text-slate-500 font-medium">지방</p>
                                <p class="text-lg font-bold text-slate-800 mt-0.5"><span id="resFat">0</span> <span class="text-xs font-normal">g</span></p>
                            </div>
                        </div>

                        <!-- Sodium & Sugar alert bar -->
                        <div class="flex items-center justify-between bg-amber-50 border border-amber-200/60 rounded-xl px-3.5 py-2 text-xs text-amber-900">
                            <div class="flex items-center space-x-2">
                                <i class="fa-solid fa-triangle-exclamation text-amber-600"></i>
                                <span>나트륨: <strong id="resSodium">0</strong> mg | 당류: <strong id="resSugar">0</strong> g</span>
                            </div>
                            <span class="text-amber-700 text-[11px]">일일 권장 기준 대비</span>
                        </div>
                    </div>

                    <!-- Individual Food Items Breakdown -->
                    <div class="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-sm space-y-3">
                        <h4 class="font-bold text-slate-800 text-sm flex items-center justify-between">
                            <span><i class="fa-solid fa-list-check text-emerald-600 mr-1.5"></i> 구성 메뉴별 영양 추정</span>
                            <span class="text-xs font-normal text-slate-400">카테고리 분량 추정</span>
                        </h4>
                        <div id="resItemsList" class="divide-y divide-slate-100">
                            <!-- Dynamic Items -->
                        </div>
                    </div>

                    <!-- AI Nutritionist Feedback Box -->
                    <div class="bg-gradient-to-br from-slate-900 to-slate-800 text-white rounded-2xl p-5 shadow-sm space-y-3">
                        <div class="flex items-center space-x-2 text-emerald-400">
                            <i class="fa-solid fa-user-doctor text-base"></i>
                            <h4 class="font-bold text-sm">AI 영양사의 맞춤 처방 & 피드백</h4>
                        </div>
                        <div class="space-y-2 text-xs leading-relaxed text-slate-200">
                            <p id="resAiSummary" class="bg-white/10 p-2.5 rounded-lg border border-white/10"></p>
                            <div class="flex items-start space-x-2 text-amber-300 bg-amber-950/30 p-2.5 rounded-lg border border-amber-500/20">
                                <i class="fa-solid fa-circle-info mt-0.5"></i>
                                <p id="resAiWarning"></p>
                            </div>
                            <div class="flex items-start space-x-2 text-emerald-300 bg-emerald-950/30 p-2.5 rounded-lg border border-emerald-500/20">
                                <i class="fa-solid fa-lightbulb mt-0.5"></i>
                                <p id="resAiTip"></p>
                            </div>
                        </div>
                    </div>

                </div>

            </div>

        </div>

    </main>

    <!-- School Input Modal -->
    <div id="schoolModal" class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 hidden flex items-center justify-center p-4">
        <div class="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4">
            <div class="flex items-center justify-between border-b border-slate-100 pb-3">
                <h3 class="font-bold text-slate-900 text-base flex items-center">
                    <i class="fa-solid fa-school text-emerald-600 mr-2"></i>
                    학교 급식 정보 입력
                </h3>
                <button onclick="closeSchoolModal()" class="text-slate-400 hover:text-slate-600"><i class="fa-solid fa-xmark text-lg"></i></button>
            </div>
            <p class="text-xs text-slate-500 leading-relaxed">
                교육청 교육정보 개방포털(NEIS) 또는 학교명을 입력해두면 AI가 식단 인식을 더욱 정확하게 수행합니다.
            </p>
            <div class="space-y-3 text-xs">
                <div>
                    <label class="block font-medium text-slate-700 mb-1">학교 이름</label>
                    <input type="text" id="modalSchoolName" placeholder="예: 서울고등학교, 한국중학교" class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-emerald-500">
                </div>
                <div>
                    <label class="block font-medium text-slate-700 mb-1">오늘의 식단 힌트 (선택)</label>
                    <input type="text" id="modalMealHint" placeholder="예: 중식 - 치킨마요덮밥, 팽이버섯국" class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-emerald-500">
                </div>
            </div>
            <div class="flex justify-end space-x-2 pt-2">
                <button onclick="closeSchoolModal()" class="px-3.5 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg">취소</button>
                <button onclick="saveSchoolInfo()" class="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg">저장하기</button>
            </div>
        </div>
    </div>

    <!-- STREAMING_CHUNK:Client scripts and image processing... -->
    <script>
        let currentImageBase64 = null;
        let currentMimeType = 'image/jpeg';
        let schoolInfoData = '';

        function formatErrorMessage(errMessage) {
            if (typeof errMessage !== 'string') return '알 수 없는 오류가 발생했습니다.';
            
            if (errMessage.includes('429') || errMessage.includes('RESOURCE_EXHAUSTED') || errMessage.includes('Quota exceeded')) {
                return 'Gemini API 사용량 한도(Quota)가 초과되었습니다. 무료 요금제 분당 제한으로 인해 약 20~30초 후 [AI 식단 칼로리 분석 시작]을 다시 클릭해 주세요.';
            }

            if (errMessage.includes('{') && errMessage.includes('}')) {
                try {
                    const jsonMatch = errMessage.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const parsed = JSON.parse(jsonMatch[0]);
                        if (parsed.error && parsed.error.message) {
                            if (parsed.error.code === 429 || parsed.error.status === 'RESOURCE_EXHAUSTED') {
                                return 'Gemini API 사용량 한도(Quota)가 초과되었습니다. 약 20~30초 후 다시 시도해 주세요.';
                            }
                            return `API 처리 오류: ${parsed.error.message.substring(0, 100)}`;
                        }
                    }
                } catch (e) {
                    // JSON 파싱 실패 시 기본 반환
                }
            }

            return errMessage;
        }

        function showToast(message) {
            const toast = document.getElementById('toastNotification');
            const msgSpan = document.getElementById('toastMessage');
            msgSpan.innerText = formatErrorMessage(message);
            toast.classList.remove('hidden');
        }

        function hideToast() {
            document.getElementById('toastNotification').classList.add('hidden');
        }

        // 이미지 고해상도 최적화 압축
        function compressAndProcessImage(file, maxWidth = 800, maxHeight = 800, quality = 0.7) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = function(e) {
                    const img = new Image();
                    img.onload = function() {
                        let width = img.width;
                        let height = img.height;

                        if (width > maxWidth || height > maxHeight) {
                            if (width > height) {
                                height = Math.round((height * maxWidth) / width);
                                width = maxWidth;
                            } else {
                                width = Math.round((width * maxHeight) / height);
                                height = maxHeight;
                            }
                        }

                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);

                        const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
                        resolve(compressedDataUrl);
                    };
                    img.onerror = () => reject(new Error('이미지 로딩 실패'));
                    img.src = e.target.result;
                };
                reader.onerror = () => reject(new Error('파일 읽기 실패'));
                reader.readAsDataURL(file);
            });
        }

        async function handleFileSelect(event) {
            const file = event.target.files[0];
            if (!file) return;

            try {
                hideToast();
                currentMimeType = 'image/jpeg';
                currentImageBase64 = await compressAndProcessImage(file);
                
                document.getElementById('imagePreview').src = currentImageBase64;
                document.getElementById('uploadPlaceholder').classList.add('hidden');
                document.getElementById('previewContainer').classList.remove('hidden');

                const analyzeBtn = document.getElementById('analyzeBtn');
                analyzeBtn.disabled = false;
                analyzeBtn.className = "mt-4 w-full py-3.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow transition duration-200 flex items-center justify-center space-x-2 cursor-pointer";
            } catch (err) {
                showToast(err.message || '사진 처리 중 오류가 발생했습니다.');
            }
        }

        function resetImage(e) {
            if (e) e.stopPropagation();
            currentImageBase64 = null;
            document.getElementById('imageInput').value = '';
            document.getElementById('uploadPlaceholder').classList.remove('hidden');
            document.getElementById('previewContainer').classList.add('hidden');

            const analyzeBtn = document.getElementById('analyzeBtn');
            analyzeBtn.disabled = true;
            analyzeBtn.className = "mt-4 w-full py-3.5 px-4 bg-slate-300 text-slate-500 font-bold rounded-xl shadow transition duration-200 flex items-center justify-center space-x-2 disabled:cursor-not-allowed";
        }

        function openSchoolModal() {
            document.getElementById('schoolModal').classList.remove('hidden');
        }

        function closeSchoolModal() {
            document.getElementById('schoolModal').classList.add('hidden');
        }

        function saveSchoolInfo() {
            const schoolName = document.getElementById('modalSchoolName').value.trim();
            const mealHint = document.getElementById('modalMealHint').value.trim();

            if (schoolName || mealHint) {
                schoolInfoData = `${schoolName ? '학교명: ' + schoolName : ''} ${mealHint ? '/ 식단: ' + mealHint : ''}`.trim();
                document.getElementById('schoolTagText').innerText = schoolInfoData;
                document.getElementById('schoolInfoDisplay').classList.remove('hidden');
            }
            closeSchoolModal();
        }

        function clearSchoolInfo() {
            schoolInfoData = '';
            document.getElementById('schoolInfoDisplay').classList.add('hidden');
            document.getElementById('modalSchoolName').value = '';
            document.getElementById('modalMealHint').value = '';
        }

        async function analyzeMealImage() {
            if (!currentImageBase64) return;
            hideToast();

            // UI 상태 변경
            document.getElementById('emptyResultState').classList.add('hidden');
            document.getElementById('resultContent').classList.add('hidden');
            document.getElementById('loadingState').classList.remove('hidden');

            try {
                let apiUrl = '/api/generate';
                try {
                    const origin = (window.location.origin && window.location.origin !== 'null' && !window.location.origin.startsWith('blob:')) 
                        ? window.location.origin 
                        : (window.location.href && window.location.href.startsWith('http') ? window.location.href : null);
                    if (origin) {
                        apiUrl = new URL('/api/generate', origin).href;
                    }
                } catch (e) {
                    console.warn('URL parsing fallback:', e);
                }

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        imageBase64: currentImageBase64,
                        mimeType: currentMimeType,
                        schoolInfo: schoolInfoData
                    })
                });

                const contentType = response.headers.get('content-type') || '';
                const rawText = await response.text();
                let resData = null;

                if (contentType.includes('application/json')) {
                    try {
                        resData = JSON.parse(rawText);
                    } catch (e) {
                        console.error('JSON Parse error:', e);
                    }
                }

                if (!resData) {
                    if (response.status === 404) {
                        throw new Error('서버리스 API 경로를 찾을 수 없습니다.');
                    } else if (response.status === 413) {
                        throw new Error('사진 용량이 초과되었습니다. 더 작은 해상도로 시도해 주세요.');
                    } else {
                        throw new Error(rawText || `서버 응답 오류 (${response.status})`);
                    }
                }

                if (!response.ok || !resData.success) {
                    throw new Error(resData.error || '식단 분석 처리 중 오류가 발생했습니다.');
                }

                renderResults(resData.data);

            } catch (error) {
                showToast(error.message || '분석 중 문제가 발생했습니다.');
                document.getElementById('emptyResultState').classList.remove('hidden');
            } finally {
                document.getElementById('loadingState').classList.add('hidden');
            }
        }

        function renderResults(data) {
            document.getElementById('resMealTitle').innerText = data.mealTitle || '급식 영양 분석 결과';
            document.getElementById('resScore').innerText = `${data.nutritionScore || 80}점`;
            document.getElementById('resCalories').innerText = data.totalCalories || 0;
            
            if (data.macronutrients) {
                document.getElementById('resCarbs').innerText = data.macronutrients.carbs || 0;
                document.getElementById('resProtein').innerText = data.macronutrients.protein || 0;
                document.getElementById('resFat').innerText = data.macronutrients.fat || 0;
                document.getElementById('resSodium').innerText = data.macronutrients.sodium || 0;
                document.getElementById('resSugar').innerText = data.macronutrients.sugar || 0;
            }

            // Render Items List
            const itemsContainer = document.getElementById('resItemsList');
            itemsContainer.innerHTML = '';

            if (data.items && Array.isArray(data.items)) {
                data.items.forEach(item => {
                    const row = document.createElement('div');
                    row.className = 'py-2.5 flex items-center justify-between text-xs';
                    row.innerHTML = `
                        <div class="flex items-center space-x-2">
                            <span class="px-2 py-0.5 rounded bg-slate-100 font-medium text-slate-600">${item.category || '기타'}</span>
                            <span class="font-bold text-slate-800">${item.name}</span>
                            <span class="text-slate-400">(${item.portion})</span>
                        </div>
                        <span class="font-bold text-emerald-700">${item.calories} kcal</span>
                    `;
                    itemsContainer.appendChild(row);
                });
            }

            // AI Feedback
            if (data.aiFeedback) {
                document.getElementById('resAiSummary').innerText = data.aiFeedback.summary || '';
                document.getElementById('resAiWarning').innerText = data.aiFeedback.warning || '';
                document.getElementById('resAiTip').innerText = data.aiFeedback.healthTip || '';
            }

            // Display Result Container
            document.getElementById('resultContent').classList.remove('hidden');
        }
    </script>
</body>
</html>
```eof

### 📌 해결 요약 및 이용 가이드
- 서버리스 함수(`api/generate.js`) 및 클라이언트(`index.html`) 양쪽 모두에서 **API 할당량 초과(429) 원문 JSON 데이터를 감지하여 깔끔한 한 줄 한국어 메시지로 자동 정제**하도록 개선하였습니다.
- 업데이트된 코드로 Vercel 프로젝트를 **Redeploy**하신 후, 약 20~30초 뒤 다시 분석을 진행하시면 정밀 분석 결과가 정상적으로 나타납니다.