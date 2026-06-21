"""
Pydantic request/response schemas for all API endpoints.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class AIProfile(BaseModel):
    name: str = Field(..., min_length=1, description="Profile name")
    provider_label: str = Field("", description="Provider label (e.g. OpenCode Go, Groq, OpenAI)")
    ai_api_base_url: str = Field("https://api.openai.com/v1")
    ai_api_key: str = Field("")
    ai_model: str = Field("qwen2.5:3b")
    suggestion_temperature: float = Field(0.1, ge=0.0, le=2.0)
    chat_temperature: float = Field(0.3, ge=0.0, le=2.0)
    suggestion_top_k: int = Field(50, ge=1, le=100)


class AddProfileRequest(BaseModel):
    profile: AIProfile


class UpdateProfileRequest(BaseModel):
    profile: AIProfile
    old_name: str


class RemoveProfileRequest(BaseModel):
    name: str


class SetActiveProfileRequest(BaseModel):
    name: str


class SettingsUpdate(BaseModel):
    references_dir: str = Field("", description="Path to local references directory (legacy)")
    reference_dirs: List[Dict] = Field([], description="List of {path, label} directories")
    ai_api_base_url: str = Field("https://api.openai.com/v1")
    ai_api_key: str = Field("", description="AI API key")
    ai_model: str = Field("qwen2.5:3b")
    embedding_model: str = Field("BAAI/bge-large-en-v1.5")
    reranker_model: str = Field("BAAI/bge-reranker-base")
    crossref_mailto: Optional[str] = Field(None, description="Optional email for Crossref polite API pool")
    crossref_timeout_seconds: Optional[float] = Field(None, ge=1.0, le=60.0, description="Crossref lookup timeout")
    suggestion_temperature: float = Field(0.1, ge=0.0, le=2.0)
    chat_temperature: float = Field(0.3, ge=0.0, le=2.0)
    suggestion_top_k: int = Field(50, ge=1, le=100)
    mcp_enabled: bool = Field(True, description="Expose the local library as MCP tools at /mcp")


class AddDirectoryRequest(BaseModel):
    dir_path: str = Field(..., description="Path to add")
    label: str = Field("", description="Optional label for this directory")


class RemoveDirectoryRequest(BaseModel):
    dir_path: str = Field(..., description="Path to remove")
    delete_items: bool = Field(False, description="Also delete items from this directory")


class TestAIRequest(BaseModel):
    ai_api_base_url: str = Field("https://api.openai.com/v1")
    ai_api_key: str = Field("")
    ai_model: str = Field("qwen2.5:3b")


class DirectoryTestRequest(BaseModel):
    dir_path: str


class CreateFolderRequest(BaseModel):
    parent_path: str = Field(..., description="Parent directory path")
    folder_name: str = Field(..., min_length=1, description="New folder name")


class RenameFolderRequest(BaseModel):
    folder_path: str = Field(..., description="Current folder path")
    new_name: str = Field(..., min_length=1, description="New folder name")
    collection_key: str = Field("", description="Collection key in DB for direct lookup")


class DeleteFolderRequest(BaseModel):
    folder_path: str = Field(..., description="Folder path to delete")
    delete_contents: bool = Field(False, description="Also delete all files inside")


class MoveItemsRequest(BaseModel):
    item_keys: List[str] = Field(..., min_length=1, description="Item keys to move")
    target_dir: str = Field(..., description="Target directory path")


class CopyItemsRequest(BaseModel):
    item_keys: List[str] = Field(..., min_length=1, description="Item keys to copy")
    target_dir: str = Field(..., description="Target directory path")


class MoveFolderRequest(BaseModel):
    folder_path: str = Field(..., description="Folder path to move")
    target_parent: str = Field(..., description="Target parent directory path")


class SyncRequest(BaseModel):
    force_resync: bool = False
    dir_path: Optional[str] = Field(None, description="Specific directory to sync (empty = sync all)")


class CitationRequest(BaseModel):
    paragraph: str = Field(..., min_length=20, description="Academic paragraph to cite")
    collection_key: Optional[str] = Field(None, description="Limit search to this collection key")
    source_dir: Optional[str] = Field(None, description="Limit search to this source directory")
    top_k: int = Field(50, ge=1, le=100, description="Number of candidate sources after reranking")
    citation_style: str = Field("apa7", description="Citation style")


class CitationSuggestion(BaseModel):
    inline_citation: str
    full_reference: str
    reason: str
    evidence_points: List[str] = []
    evidence_coverage: str = "single_point"
    confidence: str
    item_key: str
    title: str
    source_type: str
    citation_count: int = 0
    citation_count_updated_at: str = ""


class CandidateSource(BaseModel):
    item_key: str
    title: str
    year: str
    creators_formatted: str
    inline_citation: str
    full_reference: str
    best_evidence: str
    source_type: str
    similarity: float
    citation_count: int = 0
    citation_count_updated_at: str = ""


class CitationResponse(BaseModel):
    status: str
    paragraph: str
    suggestions: List[CitationSuggestion]
    warnings: List[str]
    candidates: List[CandidateSource] = []


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    paragraph: str = ""
    candidates: List[Dict] = []
    suggestions: List[Dict] = []
    history: List[ChatMessage] = []
    current_item_key: str = Field("", description="Currently open preview/library item to include as chat context")
    profile_override: str = Field("", description="Profile name to use instead of active profile")
    model_override: str = Field("", description="Model name to use for this chat request")
    restrict_to_document: bool = Field(False, description="Limit retrieval to the currently open document only")


class CheckRelevanceRequest(BaseModel):
    item_key: str
    paragraph: str


# ── Word Connector schemas ───────────────────────────────────────────────────


class WordCitationItem(BaseModel):
    item_key: str
    locator: str = ""
    locator_type: str = "page"
    prefix: str = ""
    suffix: str = ""
    suppress_author: bool = False


class WordFormatCitationRequest(BaseModel):
    items: List[WordCitationItem]
    style: str = "apa7"
    doc_id: str = ""
    citation_format: str = "parenthetical"


class WordFormatCitationResponse(BaseModel):
    formatted_text: str
    citation_data: Dict[str, Any] = {}


class WordFormatBibliographyRequest(BaseModel):
    items: List[WordCitationItem]
    style: str = "apa7"
    doc_id: str = ""


class WordFormatBibliographyResponse(BaseModel):
    bibliography: str
    entries: List[Dict[str, Any]] = []


class WordValidateCitationsRequest(BaseModel):
    citations: List[Dict[str, Any]]
    doc_id: str = ""


class WordValidateCitationsResponse(BaseModel):
    valid: List[Dict[str, Any]] = []
    missing: List[Dict[str, Any]] = []
    warnings: List[str] = []


class WordSyncCitationsRequest(BaseModel):
    doc_id: str
    citations: List[Dict[str, Any]]
    style: str = "apa7"


class WordSyncCitationsResponse(BaseModel):
    status: str
    message: str
    citation_count: int = 0


class WordDocxProcessRequest(BaseModel):
    docx_path: str
    output_path: str = ""
    style: str = "apa7"
    source_dirs: List[str] = []


class WordDocxProcessResponse(BaseModel):
    status: str
    message: str
    markers_found: int = 0
    resolved: int = 0
    warnings: List[str] = []
    output_path: str = ""
