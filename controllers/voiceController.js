// controllers/voiceController.js
const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1";

/**
 * GET /api/voices
 * Fetches Indian English voices from ElevenLabs shared voices library.
 * Supports optional query params: gender, use_case, page_size
 */
export const getIndianVoices = async (req, res) => {
  try {
    const { gender, use_case, page_size = 30, page, search } = req.query;

    const params = new URLSearchParams({
      page_size: String(page_size),
    });

    // When searching by name, don't lock to a locale — the search term
    // itself narrows results, and locale filtering excludes valid Indian
    // voices that have hi-IN, null, or other Indian locales.
    if (search) {
      // Free-text search: let ElevenLabs match by name across all locales.
      // Add a broad language hint but no locale restriction.
      params.append("search", search);
      // Still filter by language=en so we don't get pure foreign language voices,
      // but don't append locale so Indian-named voices aren't excluded.
      // Actually for search, don't even lock language — "Sai" voices might be hi/te/ta

      // Page works for search too
      if (page && page !== "1") params.append("page", page);
    } else {
      // No search: use locale to surface Indian-English voices specifically
      params.append("language", "en");
      params.append("locale", "en-IN");
      if (page) params.append("page", page);
    }

    if (gender) params.append("gender", gender);
    if (use_case) params.append("use_cases", use_case);

    const response = await fetch(
      `${ELEVENLABS_API_URL}/shared-voices?${params.toString()}`,
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ success: false, error: err });
    }

    const data = await response.json();

    // Shape the response — only what frontend needs
    const voices = (data.voices || []).map((v) => ({
      voice_id: v.voice_id,
      public_owner_id: v.public_owner_id,
      name: v.name,
      gender: v.gender,
      age: v.age,
      accent: v.accent,
      descriptive: v.descriptive,
      use_case: v.use_case,
      description: v.description,
      preview_url: v.preview_url,
      free_users_allowed: v.free_users_allowed,
      // Only expose verified models list (cleaner)
      verified_languages: v.verified_languages || [],
    }));

    return res.json({
      success: true,
      data: voices,
      has_more: data.has_more,
      total_count: data.total_count,
    });
  } catch (error) {
    console.error("Error fetching voices:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
