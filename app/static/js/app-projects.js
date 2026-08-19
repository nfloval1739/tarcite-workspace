/* ── TarCite Workspace - Project Workspaces ──────────────────────────────── */

async function loadProjects(options = {}) {
    try {
        const res = await fetch('/api/projects');
        if (!res.ok) throw new Error('Could not load projects');
        const data = await res.json();
        appState.projects = data.projects || [];
        if (!appState.activeProjectId && appState.projects.length) {
            appState.activeProjectId = appState.projects[0].project_id;
        }
        renderProjectsSidebar();
        if (appState.activeCenterView === 'projects') {
            if (appState.activeProjectId && !options.listOnly) await loadProjectDetail(appState.activeProjectId);
            else renderProjectsEmpty();
        }
    } catch (err) {
        console.error('Load projects error:', err);
        if (appState.activeCenterView === 'projects') renderProjectsEmpty('Could not load projects.');
    }
}

function renderProjectsSidebar() {
    const list = document.getElementById('projects-sidebar-list');
    if (!list) return;
    const q = (document.getElementById('project-search')?.value || '').toLowerCase();
    const projects = (appState.projects || []).filter(p => {
        const hay = `${p.name || ''} ${p.research_question || ''} ${p.objective || ''}`.toLowerCase();
        return !q || hay.includes(q);
    });
    if (!projects.length) {
        list.innerHTML = '<div class="projects-empty">No projects yet.</div>';
        renderProjectSectionNav();
        return;
    }
    list.innerHTML = projects.map(p => `
        <button class="project-list-item ${p.project_id === appState.activeProjectId ? 'active' : ''}" onclick="selectProject(${p.project_id})">
            <span class="project-list-name">${escapeHtml(p.name)}</span>
            <span class="project-list-meta">${projectTypeLabel(p.project_type)} · ${p.source_count || 0} source(s)</span>
        </button>
    `).join('');
    renderProjectSectionNav();
}

async function selectProject(projectId) {
    appState.activeProjectId = projectId;
    appState.activeProjectSection = 'overview';
    renderProjectsSidebar();
    setCenterView('projects');
    await loadProjectDetail(projectId);
}

function renderProjectsEmpty(message = '') {
    const title = document.getElementById('project-view-title');
    const subtitle = document.getElementById('project-view-subtitle');
    const content = document.getElementById('project-view-content');
    if (title) title.textContent = 'Projects';
    if (subtitle) subtitle.textContent = 'Create a workspace for a thesis chapter, article, review, or proposal.';
    if (!content) return;
    content.innerHTML = `
        <div class="project-empty-state">
            <h3>Build a focused research workspace</h3>
            <p>${escapeHtml(message || 'Projects collect sources and annotations without changing your real folders.')}</p>
            <button class="btn-small" onclick="openProjectModal()">${icon('plus')} New Project</button>
        </div>
    `;
    refreshIcons(content);
    renderProjectSectionNav();
}

async function loadProjectDetail(projectId) {
    if (!projectId) { renderProjectsEmpty(); return; }
    try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (!res.ok) throw new Error('Project not found');
        const data = await res.json();
        appState.activeProject = data.project;
        if (!projectSectionDefinitions(data.project).some(section => section.id === appState.activeProjectSection)) {
            appState.activeProjectSection = 'overview';
        }
        renderProjectDetail(data.project);
        showProjectNotesPreview(data.project);
    } catch (err) {
        console.error('Load project detail error:', err);
        renderProjectsEmpty(err.message);
    }
}

function renderProjectDetail(project) {
    const title = document.getElementById('project-view-title');
    const subtitle = document.getElementById('project-view-subtitle');
    const content = document.getElementById('project-view-content');
    if (!content) return;
    if (title) title.textContent = project.name || 'Untitled Project';
    if (subtitle) subtitle.textContent = `${projectTypeLabel(project.project_type)} · ${project.status || 'active'}`;

    const items = project.items || [];
    const annotations = project.annotations || [];
    const pinnedCount = annotations.filter(a => a.pinned_to_project).length;
    const themes = project.top_themes || [];
    const themeRoots = project.theme_roots || [];
    const codebookTagIds = projectAttachedThemeIds(themeRoots);
    const uncodedCount = annotations.filter(a => !a.tags || !a.tags.length).length;
    const reviewCount = projectCodingReviewItems(project, codebookTagIds).length;
    const section = appState.activeProjectSection || 'overview';

    content.innerHTML = `
        <div class="project-summary-grid">
            <div class="project-stat"><strong>${items.length}</strong><span>Sources</span></div>
            <div class="project-stat"><strong>${annotations.length}</strong><span>Annotations</span></div>
            <div class="project-stat"><strong>${pinnedCount}</strong><span>Pinned evidence</span></div>
            <div class="project-stat"><strong>${reviewCount}</strong><span>Need coding review</span></div>
        </div>

        ${renderProjectSection(project, section, codebookTagIds)}
    `;
    refreshIcons(content);
    renderProjectSectionNav();
    if (appState.activeProjectSection === 'analysis') {
        // Same roll-up as the cards it sits among.
        _initNetworkGraph(_rollupItems(annotations), 'proj-network-canvas', 'proj-network-empty');
    }
    requestAnimationFrame(redrawInkLines);
}

function projectSectionDefinitions(project = appState.activeProject) {
    const annotations = project?.annotations || [];
    const items = project?.items || [];
    const themeRoots = project?.theme_roots || [];
    const codebookTagIds = projectAttachedThemeIds(themeRoots);
    const reviewCount = projectCodingReviewItems(project || {}, codebookTagIds).length;
    const themeCount = themeRoots.reduce((sum, r) => sum + (r.theme_count || 0), 0);
    return [
        { id: 'overview', label: 'Overview', iconName: 'layout-dashboard', count: items.length },
        { id: 'codebook', label: 'Project Codebook', iconName: 'git-branch', count: themeCount },
        { id: 'evidence', label: 'Evidence Board', iconName: 'columns-3', count: annotations.length },
        { id: 'review', label: 'Coding Review', iconName: 'list-checks', count: reviewCount },
        { id: 'analysis', label: 'Project Analysis', iconName: 'bar-chart-3', count: annotations.length },
        { id: 'annotations', label: 'All Evidence', iconName: 'book-marked', count: annotations.length },
    ];
}

function renderProjectSectionNav() {
    const nav = document.getElementById('projects-section-nav');
    if (!nav) return;
    const project = appState.activeProject;
    if (!project || !appState.activeProjectId) {
        nav.innerHTML = '';
        return;
    }
    nav.innerHTML = `
        <div class="project-section-title">Project Sections</div>
        <div class="project-section-tree">
            ${projectSectionDefinitions(project).map(section => `
                <button class="project-section-item ${section.id === appState.activeProjectSection ? 'active' : ''}" onclick="selectProjectSection('${section.id}')">
                    ${icon(section.iconName)}
                    <span>${escapeHtml(section.label)}</span>
                    <small>${section.count}</small>
                </button>
            `).join('')}
        </div>
    `;
    refreshIcons(nav);
}

function selectProjectSection(sectionId) {
    appState.activeProjectSection = sectionId || 'overview';
    if (appState.activeProject) renderProjectDetail(appState.activeProject);
}

function renderProjectSection(project, section, codebookTagIds) {
    const items = project.items || [];
    const annotations = project.annotations || [];
    const themes = project.top_themes || [];
    const themeRoots = project.theme_roots || [];
    const uncodedCount = annotations.filter(a => !a.tags || !a.tags.length).length;
    const reviewCount = projectCodingReviewItems(project, codebookTagIds).length;

    if (section === 'codebook') {
        return `
            <section class="project-panel project-codebook-panel">
                <div class="project-panel-header">
                    <h3>Project Codebook</h3>
                    <span>${themeRoots.reduce((sum, r) => sum + (r.theme_count || 0), 0)} theme(s)</span>
                </div>
                <div class="project-codebook-toolbar">
                    <select id="project-theme-root-select" class="compact-select">
                        ${renderProjectThemeRootOptions(themeRoots)}
                    </select>
                    <button class="btn-small" onclick="attachThemeRootToProject()">${icon('link')} Attach Root</button>
                </div>
                <div class="project-codebook-list">
                    ${themeRoots.length ? themeRoots.map(renderProjectThemeRoot).join('') : '<div class="project-muted">Attach one or more root themes. Their child themes are included in this project codebook.</div>'}
                </div>
            </section>
        `;
    }

    if (section === 'evidence') {
        return `
            <section class="project-panel project-evidence-board-panel">
                <div class="project-panel-header">
                    <h3>Evidence Board</h3>
                    <span>${uncodedCount} uncoded</span>
                </div>
                <div class="project-evidence-board">
                    ${renderProjectEvidenceBoard(project, codebookTagIds)}
                </div>
            </section>
        `;
    }

    if (section === 'review') {
        return `
            <section class="project-panel project-coding-review-panel">
                <div class="project-panel-header">
                    <h3>Coding Review</h3>
                    <span>${reviewCount} item(s)</span>
                </div>
                <div class="project-coding-toolbar">
                    <button class="btn-secondary btn-small" onclick="suggestAllProjectReviewThemes()">${icon('sparkles')} Suggest Visible</button>
                    <button class="btn-secondary btn-small" onclick="autoCodeProjectReviewVisible()">${icon('wand-sparkles')} Auto-code 85%+</button>
                </div>
                <div class="project-coding-table">
                    ${renderProjectCodingReview(project, codebookTagIds)}
                </div>
            </section>
        `;
    }

    if (section === 'analysis') {
        return `
            <section class="project-panel project-analysis-panel">
                <div class="project-panel-header">
                    <div class="project-panel-title">
                        <h3>Project Analysis</h3>
                        <span>${annotations.length} annotation(s)</span>
                    </div>
                    <div class="project-analysis-export-actions">
                        <button class="analysis-export-chip" type="button" onclick="exportProjectAnalysisData()" title="Download project analysis tables for Excel">${icon('table-2')} Excel CSV</button>
                    </div>
                </div>
                ${renderProjectAnalysis(project, codebookTagIds)}
            </section>
        `;
    }

    if (section === 'annotations') {
        return `
            <section class="project-panel project-annotations-panel">
                <div class="project-panel-header">
                    <h3>Evidence & Annotations</h3>
                    <span>${annotations.length}</span>
                </div>
                <div class="project-annotation-list">
                    ${annotations.length ? annotations.slice(0, 120).map(renderProjectAnnotationRow).join('') : '<div class="project-muted">Annotations from project sources will appear here.</div>'}
                </div>
            </section>
        `;
    }

    return `
        <div class="project-meta-panel">
            <div>
                <h4>Research Question</h4>
                <p>${escapeHtml(project.research_question || 'No research question set.')}</p>
            </div>
            <div>
                <h4>Objective</h4>
                <p>${escapeHtml(project.objective || 'No objective set.')}</p>
            </div>
            <div class="project-meta-actions">
                <button class="btn-secondary btn-small" onclick="openProjectModal(${project.project_id})">${icon('pencil')} Edit</button>
                <button class="btn-secondary btn-small danger" onclick="deleteActiveProject()">${icon('trash-2')} Delete</button>
            </div>
        </div>

        <div class="project-columns">
            <section class="project-panel">
                <div class="project-panel-header">
                    <h3>Sources</h3>
                    <span>${items.length}</span>
                </div>
                <div class="project-source-list">
                    ${items.length ? items.map(renderProjectSourceRow).join('') : '<div class="project-muted">Add papers from the Library with the project button.</div>'}
                </div>
            </section>
            <section class="project-panel">
                <div class="project-panel-header">
                    <h3>Top Themes</h3>
                    <span>${themes.length}</span>
                </div>
                <div class="project-theme-list">
                    ${themes.length ? themes.map(t => `<span class="project-theme-chip" data-tag-id="${t.tag_id}" style="--theme-color:${t.color || '#3b82f6'}">#${escapeHtml(t.name)} <small>${t.count}</small></span>`).join('') : '<div class="project-muted">No coded annotations yet.</div>'}
                </div>
            </section>
        </div>
    `;
}

function flattenProjectThemeNodes(themeRoots = []) {
    const nodes = [];
    function visit(node) {
        nodes.push(node);
        (node.children || []).forEach(visit);
    }
    (themeRoots || []).forEach(root => (root.tree || []).forEach(visit));
    return nodes;
}

function projectAttachedThemeIds(themeRoots) {
    return new Set(flattenProjectThemeNodes(themeRoots).map(node => node.tag_id));
}

function renderProjectThemeRootOptions(themeRoots = []) {
    const attached = new Set((themeRoots || []).map(r => r.tag_id));
    const roots = (appState.allTags || []).filter(t => !t.parent_id && !attached.has(t.tag_id));
    if (!roots.length) return '<option value="">No unattached root themes</option>';
    return roots.map(t => `<option value="${t.tag_id}">#${escapeHtml(t.name)}</option>`).join('');
}

function renderProjectThemeRoot(root) {
    const tree = root.tree || [];
    return `
        <div class="project-codebook-root" data-tag-id="${root.tag_id}">
            <div class="project-codebook-root-head">
                <span style="color:${root.color || '#3b82f6'}">#${escapeHtml(root.name)}</span>
                <small>${root.theme_count || 0} theme(s), descendants included</small>
                <button class="project-row-icon danger" onclick="removeThemeRootFromProject(${root.tag_id})" title="Detach root">${icon('x')}</button>
            </div>
            <div class="project-codebook-tree">
                ${tree.map(node => renderProjectCodebookNode(node)).join('')}
            </div>
        </div>
    `;
}

function renderProjectCodebookNode(node, depth = 0) {
    return `
        <div class="project-codebook-node" data-tag-id="${node.tag_id}" style="--depth:${depth};--theme-color:${node.color || '#3b82f6'}">
            <span>#${escapeHtml(node.name)}</span>
            ${node.description ? `<small>${escapeHtml(node.description)}</small>` : ''}
        </div>
        ${(node.children || []).map(child => renderProjectCodebookNode(child, depth + 1)).join('')}
    `;
}

function projectCodingReviewItems(project, codebookTagIds = new Set()) {
    const annotations = project.annotations || [];
    const hasCodebook = codebookTagIds && codebookTagIds.size > 0;
    return annotations.filter(a => {
        const tagIds = (a.tags || []).map(t => t.tag_id);
        if (!tagIds.length) return true;
        if (hasCodebook && !tagIds.some(id => codebookTagIds.has(id))) return true;
        return false;
    });
}

function projectAnnotationMatchesNode(annotation, node) {
    const ids = new Set();
    function collect(n) {
        ids.add(n.tag_id);
        (n.children || []).forEach(collect);
    }
    collect(node);
    return (annotation.tags || []).some(t => ids.has(t.tag_id));
}

function renderProjectEvidenceBoard(project, codebookTagIds = new Set()) {
    const roots = project.theme_roots || [];
    const annotations = project.annotations || [];
    if (!roots.length) {
        return '<div class="project-muted">Attach root themes to see evidence grouped by your project codebook.</div>';
    }
    const codedIds = new Set();
    annotations.forEach(a => (a.tags || []).forEach(t => {
        if (codebookTagIds.has(t.tag_id)) codedIds.add(a.annotation_id);
    }));
    const uncoded = annotations.filter(a => !codedIds.has(a.annotation_id));
    return `
        <div class="project-evidence-tree">
            ${roots.map(root => (root.tree || []).map(node => renderEvidenceNode(node, annotations, 0)).join('')).join('')}
        </div>
        ${uncoded.length ? `
            <div class="project-evidence-uncoded">
                <div class="project-evidence-heading">${icon('circle-dashed')} Outside project codebook / uncoded <span>${uncoded.length}</span></div>
                ${uncoded.slice(0, 12).map(a => renderEvidenceMiniCard(a)).join('')}
            </div>` : ''}
    `;
}

function renderEvidenceNode(node, annotations, depth = 0) {
    const direct = annotations.filter(a => (a.tags || []).some(t => t.tag_id === node.tag_id));
    const descendantTotal = annotations.filter(a => projectAnnotationMatchesNode(a, node)).length;
    return `
        <div class="project-evidence-node" data-tag-id="${node.tag_id}" style="--depth:${depth};--theme-color:${node.color || '#3b82f6'}">
            <div class="project-evidence-heading">
                <span>#${escapeHtml(node.name)}</span>
                <small>${descendantTotal} evidence</small>
            </div>
            ${direct.length ? `<div class="project-evidence-cards">${direct.slice(0, 8).map(a => renderEvidenceMiniCard(a)).join('')}</div>` : ''}
            ${(node.children || []).map(child => renderEvidenceNode(child, annotations, depth + 1)).join('')}
        </div>
    `;
}

function renderEvidenceMiniCard(a) {
    const text = a.quote || a.comment || 'Empty annotation';
    return `
        <button class="project-evidence-card" data-annotation-id="${a.annotation_id}" onclick="openNoteDrawerFromCard(${a.annotation_id})" title="${escapeHtml(a.item_title || a.item_key)}">
            <span>${escapeHtml(text.slice(0, 180))}${text.length > 180 ? '…' : ''}</span>
            <small>${escapeHtml(a.item_title || a.item_key)} · p.${(a.page_index || 0) + 1}</small>
        </button>
    `;
}

function renderProjectCodingReview(project, codebookTagIds = new Set()) {
    const rows = projectCodingReviewItems(project, codebookTagIds);
    const hasCodebook = codebookTagIds.size > 0;
    if (!rows.length) {
        return '<div class="project-muted">All project annotations have at least one matching project-codebook theme.</div>';
    }
    return `
        <div class="project-coding-row project-coding-head">
            <span>Annotation</span>
            <span>Current Themes</span>
            <span>Suggested Themes</span>
            <span>Action</span>
        </div>
        ${rows.slice(0, 80).map(a => {
            const tags = a.tags || [];
            const reason = !tags.length ? 'Uncoded' : (hasCodebook ? 'Outside codebook' : 'Review');
            return `
                <div class="project-coding-row" data-review-ann-id="${a.annotation_id}" data-annotation-id="${a.annotation_id}">
                    <div class="project-coding-ann">
                        <strong>${escapeHtml(reason)}</strong>
                        <span>${escapeHtml((a.quote || a.comment || '').slice(0, 220))}${(a.quote || a.comment || '').length > 220 ? '…' : ''}</span>
                        <small>${escapeHtml(a.item_title || a.item_key)} · p.${(a.page_index || 0) + 1}</small>
                    </div>
                    <div class="project-coding-tags">${tags.length ? tags.map(t => renderTagChip(t, false)).join('') : '<span class="project-muted">None</span>'}</div>
                    <div class="project-coding-suggestions" id="coding-suggestions-${a.annotation_id}"><span class="project-muted">Not suggested yet</span></div>
                    <div class="project-coding-actions">
                        <button class="btn-secondary btn-small" onclick="suggestThemesForReviewRow(${a.annotation_id})">${icon('sparkles')} Suggest</button>
                        <button class="btn-secondary btn-small" onclick="autoCodeReviewAnnotation(${a.annotation_id})">${icon('wand-sparkles')} Auto</button>
                    </div>
                </div>
            `;
        }).join('')}
    `;
}

function renderProjectAnalysis(project, codebookTagIds = new Set()) {
    setAnalysisSource('project');
    /* The KPI row measures the codebook as authored — how much of it has
       evidence, what was coded outside it — so it must see the leaves exactly
       as coded. Only the analytical cards below take the roll-up, otherwise
       "codebook coverage" would collapse to the handful of root themes and
       report a healthy codebook as almost entirely uncovered. */
    const annotations = project.annotations || [];
    const chartItems = _rollupItems(annotations);
    const items = project.items || [];
    const codebookNodes = flattenProjectThemeNodes(project.theme_roots || []);
    const hasCodebook = codebookTagIds.size > 0;
    const coded = annotations.filter(a => (a.tags || []).length);
    const projectCoded = annotations.filter(a => (a.tags || []).some(t => codebookTagIds.has(t.tag_id)));
    const outsideCodebook = hasCodebook
        ? annotations.filter(a => (a.tags || []).length && !(a.tags || []).some(t => codebookTagIds.has(t.tag_id)))
        : [];
    const uncoded = annotations.length - coded.length;
    const codingPct = annotations.length ? Math.round((coded.length / annotations.length) * 100) : 0;
    const projectCodingPct = annotations.length ? Math.round(((hasCodebook ? projectCoded.length : coded.length) / annotations.length) * 100) : 0;

    const themeMap = new Map();
    annotations.forEach(a => (a.tags || []).forEach(t => {
        if (hasCodebook && !codebookTagIds.has(t.tag_id)) return;
        const current = themeMap.get(t.tag_id) || { ...t, count: 0 };
        current.count += 1;
        themeMap.set(t.tag_id, current);
    }));
    const coveredCodebook = hasCodebook ? codebookNodes.filter(node => themeMap.has(node.tag_id)).length : 0;
    const coveragePct = hasCodebook && codebookNodes.length ? Math.round((coveredCodebook / codebookNodes.length) * 100) : 0;

    return `
        <div class="analysis-toolbar">
            <span class="analysis-toolbar-label">Themes</span>
            <div class="analysis-rollup-toggle" role="group" aria-label="Theme level">
                <button class="analysis-rollup-btn${_analysisRollup === 'leaf' ? ' active' : ''}" type="button"
                        onclick="setAnalysisRollup('leaf')" title="Count themes exactly as coded">As coded</button>
                <button class="analysis-rollup-btn${_analysisRollup === 'root' ? ' active' : ''}" type="button"
                        onclick="setAnalysisRollup('root')" title="Fold each theme into its top-level parent">Top level</button>
            </div>
            <small class="analysis-toolbar-hint">${_analysisRollup === 'root'
                ? 'every theme counted under its top-level parent'
                : 'sub-themes counted separately from their parent'}</small>
            <span class="analysis-toolbar-sep"></span>
            <span class="analysis-toolbar-label">Text</span>
            <div class="analysis-rollup-toggle" role="group" aria-label="Text analysed">
                ${Object.entries(ANALYSIS_TEXT_SCOPE_LABELS).map(([k, label]) => `
                <button class="analysis-rollup-btn${_analysisTextScope === k ? ' active' : ''}" type="button"
                        onclick="setAnalysisTextScope('${k}')" title="Analyse ${label}">${
                            k === 'both' ? 'Both' : k === 'quote' ? 'Quotes' : 'Notes'}</button>`).join('')}
            </div>
            <small class="analysis-toolbar-hint">word frequency, TF-IDF and sentiment read ${ANALYSIS_TEXT_SCOPE_LABELS[_analysisTextScope]}</small>
        </div>
        <div class="project-analysis-summary">
            <div class="project-analysis-kpi" data-analysis-card="kpi-coding">
                <strong>${projectCodingPct}%</strong>
                <span>${hasCodebook ? 'Project-codebook coded' : 'Coded annotations'}</span>
            </div>
            <div class="project-analysis-kpi" data-analysis-card="kpi-uncoded">
                <strong>${uncoded}</strong>
                <span>Uncoded</span>
            </div>
            <div class="project-analysis-kpi" data-analysis-card="kpi-outside">
                <strong>${outsideCodebook.length}</strong>
                <span>Outside codebook</span>
            </div>
            <div class="project-analysis-kpi" data-analysis-card="kpi-themes-used">
                <strong>${coveredCodebook}</strong>
                <span>Codebook themes used</span>
            </div>
        </div>
        <div class="analysis-grid proj-analysis-grid">
            <div class="analysis-card" data-analysis-card="coding-progress">
                <div class="analysis-card-header">${icon('circle-check')} Coding Progress</div>
                ${renderAnalysisMeter(codingPct, `${coded.length} of ${annotations.length} annotations have any theme`)}
                ${hasCodebook ? renderAnalysisMeter(projectCodingPct, `${projectCoded.length} match the project codebook`) : ''}
                ${outsideCodebook.length ? `<p class="project-analysis-note">${outsideCodebook.length} coded annotation(s) use themes outside this project's attached roots.</p>` : ''}
            </div>
            <div class="analysis-card" data-analysis-card="codebook-coverage">
                <div class="analysis-card-header">${icon('network')} Codebook Coverage</div>
                ${hasCodebook
                    ? renderAnalysisMeter(coveragePct, `${coveredCodebook} of ${codebookNodes.length} project themes have evidence`)
                    : '<div class="project-muted">Attach root themes to measure codebook coverage.</div>'}
            </div>
            <div class="analysis-card" data-analysis-card="theme-frequency">${_chartThemeFrequency(chartItems, { project: true })}</div>
            <div class="analysis-card" data-analysis-card="annotation-type">${_chartAnnotationType(chartItems)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="annotations-over-time">${_chartAnnotationsOverTime(chartItems)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="word-frequency" id="proj-wf-card">${_chartProjWordFrequency(chartItems)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="co-occurrence">${_chartCoOccurrence(chartItems)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="document-matrix">${_chartDocumentMatrix(chartItems, { project: true })}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="coding-density">${_chartCodingDensity(chartItems)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="network">${_chartProjectNetworkHtml()}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="saturation">${_chartSaturation(chartItems, { project: true })}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="sentiment">${_chartSentiment(chartItems, { project: true })}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="tfidf">${_chartTFIDF(chartItems, { project: true })}</div>
            <div class="analysis-card" data-analysis-card="project-shape">
                <div class="analysis-card-header">${icon('layout-list')} Project Shape</div>
                <div class="project-analysis-list">
                    <div class="project-analysis-list-row"><span>Sources</span><strong>${items.length}</strong></div>
                    <div class="project-analysis-list-row"><span>Annotations</span><strong>${annotations.length}</strong></div>
                    <div class="project-analysis-list-row"><span>Coded</span><strong>${coded.length}</strong></div>
                    <div class="project-analysis-list-row"><span>Pinned evidence</span><strong>${annotations.filter(a => a.pinned_to_project).length}</strong></div>
                    <div class="project-analysis-list-row"><span>Codebook roots</span><strong>${project.theme_roots?.length || 0}</strong></div>
                    <div class="project-analysis-list-row"><span>Codebook themes</span><strong>${codebookNodes.length}</strong></div>
                </div>
            </div>
        </div>
    `;
}

/* Both dashboards render the same cards with the same export chips, so the
   exporters below resolve their data, their filenames and their DOM through
   here instead of assuming the project view.  Whichever dashboard renders last
   owns the chips the user can currently see. */
let _analysisSource = 'project';   // 'project' | 'library'

function setAnalysisSource(source) {
    _analysisSource = source === 'library' ? 'library' : 'project';
}

function _analysisContainerSelector() {
    return _analysisSource === 'library' ? '#analysis-content' : '#project-view-content';
}

function _analysisNetworkCanvasId() {
    return _analysisSource === 'library' ? 'network-canvas' : 'proj-network-canvas';
}

function _analysisCardSvg(card) {
    return document.querySelector(`${_analysisContainerSelector()} [data-analysis-card="${card}"] svg`);
}

function _projectAnalysisAnnotations() {
    // Mirrors the dashboard that rendered, so a CSV matches the chart it came from.
    if (_analysisSource === 'library') return _rollupItems(_filteredAnnotations());
    return _rollupItems(appState.activeProject?.annotations || []);
}

// Resolve a CSS custom property to its actual value at call time.
// SVG presentation attributes don't always inherit custom properties in
// older WebKit builds; use this for SVG stroke/fill attribute values.
function _cssVar(name, fallback = '') {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function _csv(rows) {
    return rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

function _downloadTextFile(filename, content, type = 'text/plain;charset=utf-8;') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function _projectAnalysisSlug() {
    if (_analysisSource === 'library') return 'library';
    const name = appState.activeProject?.name || 'project';
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
}

function _networkDataFromAnnotations(items) {
    const nodeMap = {};
    const edgeMap = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!nodeMap[t.tag_id]) nodeMap[t.tag_id] = { id: t.tag_id, name: t.name, color: t.color || '#3b82f6', count: 0 };
        nodeMap[t.tag_id].count++;
    }));
    items.forEach(a => {
        const tags = a.tags || [];
        for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
            const ordered = [tags[i], tags[j]].sort((aTag, bTag) => Number(aTag.tag_id) - Number(bTag.tag_id));
            const key = `${ordered[0].tag_id}-${ordered[1].tag_id}`;
            if (!edgeMap[key]) {
                edgeMap[key] = {
                    source_id: ordered[0].tag_id,
                    source: ordered[0].name,
                    target_id: ordered[1].tag_id,
                    target: ordered[1].name,
                    count: 0,
                };
            }
            edgeMap[key].count++;
        }
    });
    return {
        nodes: Object.values(nodeMap).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        edges: Object.values(edgeMap).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    };
}

/* Rows for the saturation CSV, taken from the same series the curve is drawn
   from.  This used to re-derive them, ordering by annotation_id — import order,
   not reading order — so the exported "cumulative_themes" column described a
   different corpus from the chart it sits under. */
function _saturationRows(items) {
    return _saturationSeries(items).rows.map(r => ({
        annotation_index: r.n,
        annotation_id: r.annotation.annotation_id,
        source: r.annotation.item_title || r.annotation.item_key,
        page: (r.annotation.page_index || 0) + 1,
        themes_on_annotation: (r.annotation.tags || []).map(t => t.name).join('; '),
        new_themes: r.newThemes.map(t => t.name).join('; '),
        new_theme_count: r.newThemes.length,
        cumulative_themes: r.total,
    }));
}

function exportProjectAnalysisData() {
    const items = _projectAnalysisAnnotations();
    if (!items.length) { alert('No project annotations to export.'); return; }

    const sections = [];
    const network = _networkDataFromAnnotations(items);
    const saturation = _saturationRows(items);

    const themeRows = network.nodes.map(n => [n.id, n.name, n.count, n.color]);
    sections.push('=== Theme Frequency ===');
    sections.push(_csv([['theme_id', 'theme', 'count', 'color'], ...themeRows]));

    sections.push('\r\n=== Theme Relationship Network - Nodes ===');
    sections.push(_csv([['theme_id', 'theme', 'count', 'color'], ...themeRows]));

    sections.push('\r\n=== Theme Relationship Network - Edges ===');
    sections.push(_csv([
        ['source_theme_id', 'source_theme', 'target_theme_id', 'target_theme', 'co_occurrences'],
        ...network.edges.map(e => [e.source_id, e.source, e.target_id, e.target, e.count]),
    ]));

    sections.push('\r\n=== Theme Saturation Curve ===');
    sections.push(_csv([
        ['annotation_index', 'annotation_id', 'source', 'page', 'themes_on_annotation', 'new_themes', 'new_theme_count', 'cumulative_themes'],
        ...saturation.map(r => [r.annotation_index, r.annotation_id, r.source, r.page, r.themes_on_annotation, r.new_themes, r.new_theme_count, r.cumulative_themes]),
    ]));

    sections.push('\r\n=== Annotation Source Data ===');
    sections.push(_csv([
        ['annotation_id', 'source', 'page', 'type', 'themes', 'quote', 'note'],
        ...items.map(a => [
            a.annotation_id,
            a.item_title || a.item_key,
            (a.page_index || 0) + 1,
            a.annotation_type || '',
            (a.tags || []).map(t => t.name).join('; '),
            a.quote || '',
            a.comment || '',
        ]),
    ]));

    _downloadTextFile(`project_analysis_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`, '\ufeff' + sections.join('\r\n'), 'text/csv;charset=utf-8;');
}

function exportProjectNetworkData() {
    const items = _projectAnalysisAnnotations();
    const network = _networkDataFromAnnotations(items);
    if (!network.nodes.length) { alert('No network data to export.'); return; }
    const sections = [
        '=== Nodes ===',
        _csv([['theme_id', 'theme', 'count', 'color'], ...network.nodes.map(n => [n.id, n.name, n.count, n.color])]),
        '\r\n=== Edges ===',
        _csv([
            ['source_theme_id', 'source_theme', 'target_theme_id', 'target_theme', 'co_occurrences'],
            ...network.edges.map(e => [e.source_id, e.source, e.target_id, e.target, e.count]),
        ]),
    ];
    _downloadTextFile(`theme_network_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`, '\ufeff' + sections.join('\r\n'), 'text/csv;charset=utf-8;');
}

function exportProjectNetworkPng() {
    const canvas = document.getElementById(_analysisNetworkCanvasId());
    if (!canvas || canvas.style.display === 'none') { alert('No project network image to export.'); return; }
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `theme_network_${_projectAnalysisSlug()}_${_exportDateStamp()}.png`;
    a.click();
}

function exportProjectNetworkSvg() {
    if (!_netState || _netState.canvas?.id !== _analysisNetworkCanvasId()) {
        alert('Open the analysis view first so the network can be exported.');
        return;
    }
    const { nodes, edgeList, idxMap, maxW, edgeStyle, W, H } = _netState;
    if (!nodes.length || !edgeList.length) { alert('No network SVG to export.'); return; }
    const dashMap = { solid: '', dashed: ' stroke-dasharray="8 5"', dotted: ' stroke-dasharray="2 4"' };
    const dash = dashMap[_netState.edgeDash] || '';
    const edgeColor = _netState.edgeColor === 'auto' ? '#94a3b8' : _netState.edgeColor;
    const edgePaths = edgeList.map(e => {
        const a = nodes[idxMap[e.s]], b = nodes[idxMap[e.t]];
        if (!a || !b) return '';
        const lw = Math.max(1, e.w / maxW * 7).toFixed(2);
        let d = `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} L ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
        if (edgeStyle === 'curved') {
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const bend = Math.min(len * 0.35, 70);
            const cpx = (a.x + b.x) / 2 - (dy / len) * bend;
            const cpy = (a.y + b.y) / 2 + (dx / len) * bend;
            d = `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cpx.toFixed(1)} ${cpy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
        } else if (edgeStyle === 'elbow') {
            const mx = (a.x + b.x) / 2;
            d = `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} L ${mx.toFixed(1)} ${a.y.toFixed(1)} L ${mx.toFixed(1)} ${b.y.toFixed(1)} L ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
        }
        return `<path d="${d}" fill="none" stroke="${edgeColor}" stroke-width="${lw}" stroke-linecap="round" opacity="0.65"${dash}/>`;
    }).join('');
    const nodeEls = nodes.map(n => {
        const label = n.name.length > 18 ? n.name.slice(0, 17) + '...' : n.name;
        return `<g>
            <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r.toFixed(1)}" fill="${n.color}" fill-opacity="0.82" stroke="${n.color}" stroke-width="2"/>
            <text x="${n.x.toFixed(1)}" y="${(n.y + 4).toFixed(1)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(8, n.r * 0.62).toFixed(1)}" font-weight="700" fill="#fff">${n.count}</text>
            <text x="${n.x.toFixed(1)}" y="${(n.y + n.r + 14).toFixed(1)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#334155">${escapeHtml(label)}</text>
        </g>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W)}" height="${Math.round(H)}" viewBox="0 0 ${Math.round(W)} ${Math.round(H)}">
        <rect width="100%" height="100%" fill="#f8fafc"/>
        ${edgePaths}
        ${nodeEls}
    </svg>`;
    _downloadTextFile(`theme_network_${_projectAnalysisSlug()}_${_exportDateStamp()}.svg`, svg, 'image/svg+xml;charset=utf-8;');
}

function exportProjectSaturationData() {
    const rows = _saturationRows(_projectAnalysisAnnotations());
    if (!rows.length) { alert('No saturation data to export.'); return; }
    _downloadTextFile(`theme_saturation_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`, '\ufeff' + _csv([
        ['annotation_index', 'annotation_id', 'source', 'page', 'themes_on_annotation', 'new_themes', 'new_theme_count', 'cumulative_themes'],
        ...rows.map(r => [r.annotation_index, r.annotation_id, r.source, r.page, r.themes_on_annotation, r.new_themes, r.new_theme_count, r.cumulative_themes]),
    ]), 'text/csv;charset=utf-8;');
}

function exportProjectSaturationSvg() {
    const svg = _analysisCardSvg("saturation");
    if (!svg) { alert('No saturation SVG to export.'); return; }
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const style = document.createElement('style');
    style.textContent = `
        svg { background: #fff; }
        text { font-family: Arial, sans-serif; }
        .lucide { display: none; }
    `;
    clone.insertBefore(style, clone.firstChild);
    const rootStyle = getComputedStyle(document.documentElement);
    const replacements = {
        'var(--accent)': rootStyle.getPropertyValue('--accent').trim() || '#3b82f6',
        'var(--border)': rootStyle.getPropertyValue('--border').trim() || '#334155',
        'var(--border-color)': rootStyle.getPropertyValue('--border-color').trim() || '#334155',
        'var(--text-muted)': rootStyle.getPropertyValue('--text-muted').trim() || '#64748b',
        'var(--bg-card)': rootStyle.getPropertyValue('--bg-card').trim() || '#ffffff',
    };
    let svgText = clone.outerHTML;
    Object.entries(replacements).forEach(([needle, value]) => {
        svgText = svgText.split(needle).join(value);
    });
    _downloadTextFile(`theme_saturation_${_projectAnalysisSlug()}_${_exportDateStamp()}.svg`, svgText, 'image/svg+xml;charset=utf-8;');
}

function exportProjectSaturationPng() {
    const svg = _analysisCardSvg("saturation");
    if (!svg) { alert('Open Project Analysis first to render the saturation chart.'); return; }
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const rs = getComputedStyle(document.documentElement);
    const replacements = { 'var(--accent)': rs.getPropertyValue('--accent').trim() || '#2d6fd4', 'var(--border-color)': rs.getPropertyValue('--border-color').trim() || '#1e3a6a', 'var(--text-muted)': rs.getPropertyValue('--text-muted').trim() || '#5a6d8e', 'var(--bg-card)': rs.getPropertyValue('--bg-card').trim() || '#132850' };
    let svgText = clone.outerHTML;
    Object.entries(replacements).forEach(([k, v]) => { svgText = svgText.split(k).join(v); });
    _svgAsPng(svgText, `theme_saturation_${_projectAnalysisSlug()}_${_exportDateStamp()}.png`);
}

// ── Chart image export helpers ────────────────────────────────────────────────

function _svgAsPng(svgText, filename, scale = 2) {
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth * scale;
        canvas.height = img.naturalHeight * scale;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = filename;
        a.click();
    };
    img.onerror = () => { URL.revokeObjectURL(url); alert('Image export failed.'); };
    img.src = url;
}

// Escape text for SVG/XML text nodes (&, <, >, " must become entities)
const _sx = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const _svgWrap = (inner, W, H, title) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="100%" height="100%" fill="#f8fafc"/>` +
    `<text x="14" y="22" font-family="Arial,sans-serif" font-size="13" font-weight="700" fill="#1e293b">${_sx(title)}</text>` +
    inner + `</svg>`;

function _buildThemeFrequencySvg() {
    const items = _projectAnalysisAnnotations();
    const counts = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!counts[t.tag_id]) counts[t.tag_id] = { name: t.name, color: t.color, count: 0 };
        counts[t.tag_id].count++;
    }));
    const sorted = Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 15);
    if (!sorted.length) return null;
    const max = sorted[0].count;
    const rowH = 24, labelW = 130, barMaxW = 260, pad = 14;
    const W = pad + labelW + barMaxW + 36 + pad;
    const H = 32 + sorted.length * rowH + pad;
    const rows = sorted.map((t, i) => {
        const y = 32 + i * rowH;
        const bw = (t.count / max * barMaxW).toFixed(1);
        const label = _sx(t.name.length > 20 ? t.name.slice(0, 19) + '…' : t.name);
        return `<text x="${pad}" y="${y + 15}" font-family="Arial,sans-serif" font-size="11" fill="#334155">${label}</text>` +
               `<rect x="${pad + labelW}" y="${y + 4}" width="${bw}" height="${rowH - 8}" rx="3" fill="${t.color || '#2d6fd4'}" fill-opacity="0.85"/>` +
               `<text x="${pad + labelW + parseFloat(bw) + 5}" y="${y + 15}" font-family="Arial,sans-serif" font-size="10" fill="#64748b">${t.count}</text>`;
    }).join('');
    return _svgWrap(rows, W, H, 'Theme Frequency');
}

function _buildSentimentSvg() {
    // Re-use the DOM SVG element for sentiment (donut already rendered)
    const el = _analysisCardSvg("sentiment");
    if (!el) return null;
    const clone = el.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    // Replace any remaining CSS vars
    let txt = clone.outerHTML;
    const rs = getComputedStyle(document.documentElement);
    [['--bg-tertiary','#162d5a'],['--accent','#2d6fd4'],['--text-muted','#5a6d8e'],['--bg-card','#132850']].forEach(([v, fb]) => {
        txt = txt.split(`var(${v})`).join(rs.getPropertyValue(v).trim() || fb);
    });
    return txt;
}

function _buildTFIDFSvg() {
    const items = _projectAnalysisAnnotations();
    const themeCorpus = {};
    items.forEach(a => {
        const text = ((a.quote || '') + ' ' + (a.comment || '')).toLowerCase();
        (a.tags || []).forEach(t => {
            if (!themeCorpus[t.tag_id]) themeCorpus[t.tag_id] = { ...t, words: [] };
            themeCorpus[t.tag_id].words.push(...(text.match(/[a-z]{3,}/g) || []).filter(w => !_STOPWORDS.has(w)));
        });
    });
    const themes = Object.values(themeCorpus).filter(t => t.words.length >= 5).slice(0, 6);
    if (!themes.length) return null;
    const N = themes.length;
    const wordDocFreq = {};
    themes.forEach(t => new Set(t.words).forEach(w => { wordDocFreq[w] = (wordDocFreq[w] || 0) + 1; }));
    themes.forEach(t => {
        const tf = {}; t.words.forEach(w => { tf[w] = (tf[w] || 0) + 1; });
        const total = t.words.length;
        t.tfidf = Object.entries(tf).map(([w, f]) => ({ w, score: (f / total) * Math.log((N + 1) / (wordDocFreq[w] || 1)) }))
            .filter(x => x.score > 0.0001).sort((a, b) => b.score - a.score).slice(0, 6);
        t.maxScore = t.tfidf[0]?.score || 1;
    });
    const colW = 160, rowH = 20, pad = 12, headerH = 32;
    const cols = Math.min(themes.length, 3), rows2 = Math.ceil(themes.length / cols);
    const W = pad + cols * (colW + pad);
    const H = pad + 20 + rows2 * (headerH + 6 * rowH + pad);
    const blocks = themes.map((t, idx) => {
        const col = idx % cols, row = Math.floor(idx / cols);
        const bx = pad + col * (colW + pad);
        const by = pad + 20 + row * (headerH + 6 * rowH + pad);
        const bars = t.tfidf.map((entry, i) => {
            const bw = (entry.score / t.maxScore * (colW - 80)).toFixed(1);
            return `<text x="${bx + 2}" y="${by + headerH + i * rowH + 13}" font-family="Arial,sans-serif" font-size="10" fill="#334155">${_sx(entry.w)}</text>` +
                   `<rect x="${bx + 78}" y="${by + headerH + i * rowH + 2}" width="${bw}" height="${rowH - 5}" rx="2" fill="${t.color || '#2d6fd4'}" fill-opacity="0.75"/>`;
        }).join('\n');
        const tLabel = _sx(t.name.length > 18 ? t.name.slice(0, 17) + '…' : t.name);
        return `<text x="${bx + 2}" y="${by + 16}" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="${t.color || '#2d6fd4'}">${tLabel}</text>${bars}`;
    }).join('');
    return _svgWrap(blocks, W, H, 'TF-IDF per Theme');
}

function _buildDocumentMatrixSvg() {
    const items = _projectAnalysisAnnotations();
    const themeCounts = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!themeCounts[t.tag_id]) themeCounts[t.tag_id] = { ...t, c: 0 };
        themeCounts[t.tag_id].c++;
    }));
    const topThemes = Object.values(themeCounts).sort((a, b) => b.c - a.c).slice(0, 10);
    const docsMap = {};
    items.forEach(a => { if (!docsMap[a.item_key]) docsMap[a.item_key] = a.item_title || a.item_key; });
    const topDocs = Object.entries(docsMap).slice(0, 8);
    if (!topThemes.length || !topDocs.length) return null;
    const matrix = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!matrix[t.tag_id]) matrix[t.tag_id] = {};
        matrix[t.tag_id][a.item_key] = (matrix[t.tag_id][a.item_key] || 0) + 1;
    }));
    const maxVal = Math.max(1, ...topThemes.flatMap(t => topDocs.map(([k]) => matrix[t.tag_id]?.[k] || 0)));
    const cellW = 44, cellH = 26, labelW = 120, headerH = 54, pad = 10;
    const W = pad + labelW + topDocs.length * cellW + pad;
    const H = pad + headerH + topThemes.length * cellH + pad;
    const headers = topDocs.map(([, title], i) => {
        const x = pad + labelW + i * cellW + cellW / 2;
        const short = _sx(title.length > 10 ? title.slice(0, 9) + '…' : title);
        return `<text x="${x}" y="${pad + headerH - 4}" transform="rotate(-45 ${x} ${pad + headerH - 4})" font-family="Arial,sans-serif" font-size="9" fill="#334155" text-anchor="end">${short}</text>`;
    }).join('');
    const rowEls = topThemes.map((t, ri) => {
        const y = pad + headerH + ri * cellH;
        const cells = topDocs.map(([k], ci) => {
            const v = matrix[t.tag_id]?.[k] || 0;
            const alpha = v ? (v / maxVal * 0.75 + 0.1).toFixed(2) : '0';
            const cx = pad + labelW + ci * cellW;
            return `<rect x="${cx}" y="${y}" width="${cellW - 1}" height="${cellH - 1}" fill="${t.color || '#2d6fd4'}" fill-opacity="${alpha}"/>` +
                   (v ? `<text x="${cx + cellW / 2}" y="${y + cellH / 2 + 4}" font-family="Arial,sans-serif" font-size="10" fill="#fff" text-anchor="middle">${v}</text>` : '');
        }).join('');
        const tLabel = _sx(t.name.length > 16 ? t.name.slice(0, 15) + '…' : t.name);
        return `<text x="${pad + labelW - 4}" y="${y + cellH / 2 + 4}" font-family="Arial,sans-serif" font-size="10" fill="${t.color || '#334155'}" text-anchor="end">${tLabel}</text>${cells}`;
    }).join('');
    return _svgWrap(headers + rowEls, W, H, 'Theme × Document Matrix');
}

function exportProjectThemeFrequencyData() {
    const items = _projectAnalysisAnnotations();
    const counts = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!counts[t.tag_id]) counts[t.tag_id] = { name: t.name, color: t.color || '', count: 0 };
        counts[t.tag_id].count++;
    }));
    const rows = Object.values(counts).sort((a, b) => b.count - a.count);
    if (!rows.length) { alert('No theme data to export.'); return; }
    _downloadTextFile(
        `theme_frequency_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`,
        '﻿' + _csv([['theme', 'count', 'color'], ...rows.map(r => [r.name, r.count, r.color])]),
        'text/csv;charset=utf-8;',
    );
}

function exportProjectSentimentData() {
    const items = _projectAnalysisAnnotations();
    if (!items.length) { alert('No annotations to export.'); return; }
    const tagged = items.map(a => {
        if (a.sentiment) return { ...a, _sent: a.sentiment, _manual: true };
        const words = ((a.quote || '') + ' ' + (a.comment || '')).toLowerCase().match(/[a-z]{3,}/g) || [];
        let score = 0;
        words.forEach(w => { if (_POS_WORDS.has(w)) score++; if (_NEG_WORDS.has(w)) score--; });
        return { ...a, _sent: score > 0 ? 'pos' : score < 0 ? 'neg' : 'neu', _manual: false };
    });
    _downloadTextFile(
        `annotation_sentiment_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`,
        '﻿' + _csv([
            ['annotation_id', 'source', 'page', 'sentiment', 'manual_flag', 'themes', 'quote'],
            ...tagged.map(a => [
                a.annotation_id,
                a.item_title || a.item_key,
                (a.page_index || 0) + 1,
                a._sent,
                a._manual ? 'yes' : 'no',
                (a.tags || []).map(t => t.name).join('; '),
                a.quote || '',
            ]),
        ]),
        'text/csv;charset=utf-8;',
    );
}

function exportProjectTFIDFData() {
    const items = _projectAnalysisAnnotations();
    const themeCorpus = {};
    items.forEach(a => {
        const text = ((a.quote || '') + ' ' + (a.comment || '')).toLowerCase();
        (a.tags || []).forEach(t => {
            if (!themeCorpus[t.tag_id]) themeCorpus[t.tag_id] = { ...t, words: [] };
            themeCorpus[t.tag_id].words.push(...(text.match(/[a-z]{3,}/g) || []).filter(w => !_STOPWORDS.has(w)));
        });
    });
    const themes = Object.values(themeCorpus).filter(t => t.words.length >= 5);
    if (!themes.length) { alert('Not enough coded annotations to compute TF-IDF.'); return; }
    const N = themes.length;
    const wordDocFreq = {};
    themes.forEach(t => new Set(t.words).forEach(w => { wordDocFreq[w] = (wordDocFreq[w] || 0) + 1; }));
    const rows = [['theme', 'word', 'tfidf_score']];
    themes.forEach(t => {
        const tf = {};
        t.words.forEach(w => { tf[w] = (tf[w] || 0) + 1; });
        const total = t.words.length;
        Object.entries(tf)
            .map(([w, f]) => ({ w, score: (f / total) * Math.log((N + 1) / (wordDocFreq[w] || 1)) }))
            .filter(x => x.score > 0.0001).sort((a, b) => b.score - a.score).slice(0, 10)
            .forEach(({ w, score }) => rows.push([t.name, w, score.toFixed(4)]));
    });
    _downloadTextFile(
        `tfidf_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`,
        '﻿' + _csv(rows),
        'text/csv;charset=utf-8;',
    );
}

function exportProjectDocumentMatrixData() {
    const items = _projectAnalysisAnnotations();
    const themeCounts = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!themeCounts[t.tag_id]) themeCounts[t.tag_id] = { ...t, c: 0 };
        themeCounts[t.tag_id].c++;
    }));
    const topThemes = Object.values(themeCounts).sort((a, b) => b.c - a.c).slice(0, 20);
    const docsMap = {};
    items.forEach(a => { if (!docsMap[a.item_key]) docsMap[a.item_key] = a.item_title || a.item_key; });
    const topDocs = Object.entries(docsMap);
    if (!topThemes.length || !topDocs.length) { alert('Not enough data to export matrix.'); return; }
    const matrix = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!matrix[t.tag_id]) matrix[t.tag_id] = {};
        matrix[t.tag_id][a.item_key] = (matrix[t.tag_id][a.item_key] || 0) + 1;
    }));
    const header = ['theme', ...topDocs.map(([, title]) => title)];
    const rows = topThemes.map(t => [t.name, ...topDocs.map(([k]) => matrix[t.tag_id]?.[k] || 0)]);
    _downloadTextFile(
        `theme_document_matrix_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`,
        '﻿' + _csv([header, ...rows]),
        'text/csv;charset=utf-8;',
    );
}

function exportProjectThemeFrequencySvg() {
    const svg = _buildThemeFrequencySvg();
    if (!svg) { alert('No theme data to export.'); return; }
    _downloadTextFile(`theme_frequency_${_projectAnalysisSlug()}_${_exportDateStamp()}.svg`, svg, 'image/svg+xml;charset=utf-8;');
}
function exportProjectThemeFrequencyPng() {
    const svg = _buildThemeFrequencySvg();
    if (!svg) { alert('No theme data to export.'); return; }
    _svgAsPng(svg, `theme_frequency_${_projectAnalysisSlug()}_${_exportDateStamp()}.png`);
}

function exportProjectSentimentSvg() {
    const svg = _buildSentimentSvg();
    if (!svg) { alert('Open Project Analysis first to render the sentiment chart.'); return; }
    _downloadTextFile(`annotation_sentiment_${_projectAnalysisSlug()}_${_exportDateStamp()}.svg`, svg, 'image/svg+xml;charset=utf-8;');
}
function exportProjectSentimentPng() {
    const svg = _buildSentimentSvg();
    if (!svg) { alert('Open Project Analysis first to render the sentiment chart.'); return; }
    _svgAsPng(svg, `annotation_sentiment_${_projectAnalysisSlug()}_${_exportDateStamp()}.png`);
}

function exportProjectTFIDFSvg() {
    const svg = _buildTFIDFSvg();
    if (!svg) { alert('Not enough coded annotations to generate TF-IDF chart.'); return; }
    _downloadTextFile(`tfidf_${_projectAnalysisSlug()}_${_exportDateStamp()}.svg`, svg, 'image/svg+xml;charset=utf-8;');
}
function exportProjectTFIDFPng() {
    const svg = _buildTFIDFSvg();
    if (!svg) { alert('Not enough coded annotations to generate TF-IDF chart.'); return; }
    _svgAsPng(svg, `tfidf_${_projectAnalysisSlug()}_${_exportDateStamp()}.png`);
}

function exportProjectDocumentMatrixSvg() {
    const svg = _buildDocumentMatrixSvg();
    if (!svg) { alert('Not enough data to generate matrix.'); return; }
    _downloadTextFile(`theme_document_matrix_${_projectAnalysisSlug()}_${_exportDateStamp()}.svg`, svg, 'image/svg+xml;charset=utf-8;');
}
function exportProjectDocumentMatrixPng() {
    const svg = _buildDocumentMatrixSvg();
    if (!svg) { alert('Not enough data to generate matrix.'); return; }
    _svgAsPng(svg, `theme_document_matrix_${_projectAnalysisSlug()}_${_exportDateStamp()}.png`);
}

function countBy(items, keyFn) {
    const counts = new Map();
    (items || []).forEach(item => {
        const key = keyFn(item) || 'Unknown';
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    return Array.from(counts.entries())
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value || String(a.label).localeCompare(String(b.label)));
}

function projectAnnotationTypeLabel(type) {
    const labels = {
        highlight: 'Highlight',
        underline: 'Underline',
        comment: 'Comment',
        area: 'Area',
    };
    return labels[type] || 'Other';
}

function projectSentimentLabel(value) {
    if (value === 'pos') return 'Positive';
    if (value === 'neg') return 'Negative';
    if (value === 'neu') return 'Neutral';
    return 'Unknown';
}

function projectThemeCooccurrence(annotations, codebookTagIds = new Set()) {
    const hasCodebook = codebookTagIds.size > 0;
    const pairs = new Map();
    annotations.forEach(a => {
        const tags = (a.tags || [])
            .filter(t => !hasCodebook || codebookTagIds.has(t.tag_id))
            .sort((x, y) => x.name.localeCompare(y.name));
        for (let i = 0; i < tags.length; i += 1) {
            for (let j = i + 1; j < tags.length; j += 1) {
                const key = `${tags[i].tag_id}:${tags[j].tag_id}`;
                const current = pairs.get(key) || { label: `#${tags[i].name} + #${tags[j].name}`, value: 0 };
                current.value += 1;
                pairs.set(key, current);
            }
        }
    });
    return Array.from(pairs.values()).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

function renderAnalysisMeter(percent, label) {
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    return `
        <div class="project-analysis-meter">
            <div class="project-analysis-meter-top">
                <span>${escapeHtml(label)}</span>
                <strong>${safePercent}%</strong>
            </div>
            <div class="project-analysis-meter-track">
                <div class="project-analysis-meter-fill" style="width:${safePercent}%"></div>
            </div>
        </div>
    `;
}

function renderAnalysisBars(rows, maxValue = null) {
    if (!rows || !rows.length) return '<div class="project-muted">No data yet.</div>';
    const max = maxValue || Math.max(...rows.map(r => r.value), 1);
    return `
        <div class="project-analysis-bars">
            ${rows.map(row => {
                const pct = Math.max(4, Math.round((row.value / Math.max(1, max)) * 100));
                return `
                    <div class="project-analysis-bar-row">
                        <span title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span>
                        <div class="project-analysis-bar-track">
                            <div class="project-analysis-bar-fill" style="width:${pct}%;--bar-color:${row.color || 'var(--accent)'}"></div>
                        </div>
                        <strong>${row.value}</strong>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderProjectSourceRow(item) {
    const title = item.title || item.item_key;
    return `
        <div class="project-source-row" data-item-key="${escapeHtml(item.item_key)}">
            <button onclick="openPreview('${escapeJs(item.item_key)}')" title="${escapeHtml(title)}">
                <strong>${escapeHtml(title)}</strong>
                <span>${escapeHtml(item.year || '-')}${item.annotation_count ? ` · ${item.annotation_count} annotation(s)` : ''}</span>
            </button>
            <button class="project-row-icon danger" onclick="removeItemFromProject('${escapeJs(item.item_key)}')" title="Remove from project">${icon('x')}</button>
        </div>
    `;
}

function renderProjectAnnotationRow(a) {
    const tagsHtml = (a.tags || []).map(t => renderTagChip(t, false)).join('');
    return `
        <div class="project-ann-row ${a.pinned_to_project ? 'pinned' : ''}" data-annotation-id="${a.annotation_id}">
            <div class="project-ann-color" style="background:${a.color || '#ccc'}"></div>
            <div class="project-ann-body">
                ${a.quote ? `<div class="project-ann-quote">"${escapeHtml(a.quote.slice(0, 260))}${a.quote.length > 260 ? '…' : ''}"</div>` : ''}
                ${a.comment ? `<div class="project-ann-note">${escapeHtml(a.comment)}</div>` : ''}
                <div class="project-ann-meta">
                    <span>${escapeHtml(a.item_title || a.item_key)}</span>
                    <span>p.${(a.page_index || 0) + 1}</span>
                    ${tagsHtml}
                </div>
            </div>
            <div class="project-ann-actions">
                <button class="ann-card-btn" onclick="suggestThemesForAnnotation(${a.annotation_id})" title="Suggest themes">${icon('sparkles')}</button>
                <button class="ann-card-btn" onclick="openNoteDrawerFromCard(${a.annotation_id})" title="Edit">${icon('pencil')}</button>
                ${a.pinned_to_project
                    ? `<button class="ann-card-btn danger" onclick="removeAnnotationFromProject(${a.annotation_id})" title="Unpin">${icon('pin-off')}</button>`
                    : `<button class="ann-card-btn" onclick="pinAnnotationToActiveProject(${a.annotation_id})" title="Pin to project">${icon('pin')}</button>`}
            </div>
        </div>
    `;
}

function openProjectModal(projectId = null) {
    const project = projectId ? appState.projects.find(p => p.project_id === projectId) || appState.activeProject : null;
    document.getElementById('project-modal-title').textContent = project ? 'Edit Project' : 'New Project';
    document.getElementById('project-edit-id').value = project?.project_id || '';
    document.getElementById('project-name').value = project?.name || '';
    document.getElementById('project-type').value = project?.project_type || 'thesis_chapter';
    document.getElementById('project-status').value = project?.status || 'active';
    document.getElementById('project-research-question').value = project?.research_question || '';
    document.getElementById('project-objective').value = project?.objective || '';
    setInlineResult('project-msg', '');
    openModal('project-modal');
    setTimeout(() => document.getElementById('project-name')?.focus(), 50);
}

async function saveProject() {
    const projectId = document.getElementById('project-edit-id').value;
    const payload = {
        name: document.getElementById('project-name').value.trim(),
        project_type: document.getElementById('project-type').value,
        status: document.getElementById('project-status').value,
        research_question: document.getElementById('project-research-question').value.trim(),
        objective: document.getElementById('project-objective').value.trim(),
    };
    if (!payload.name) {
        setInlineResult('project-msg', 'Project name is required.', 'error');
        return;
    }
    try {
        const res = await fetch(projectId ? `/api/projects/${projectId}` : '/api/projects', {
            method: projectId ? 'PATCH' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Could not save project');
        closeModal('project-modal');
        appState.activeProjectId = data.project?.project_id || data.project_id || appState.activeProjectId;
        await loadProjects();
    } catch (err) {
        setInlineResult('project-msg', err.message, 'error');
    }
}

async function deleteActiveProject() {
    const project = appState.activeProject;
    if (!project || !confirm(`Delete project "${project.name}"?\n\nThis does not delete source files or annotations.`)) return;
    try {
        const res = await fetch(`/api/projects/${project.project_id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Could not delete project');
        appState.activeProjectId = null;
        appState.activeProject = null;
        await loadProjects();
    } catch (err) {
        alert(err.message);
    }
}

async function openProjectAssignModal(type, id) {
    if (!appState.projects.length) await loadProjects({ listOnly: true });
    if (!appState.projects.length) {
        if (confirm('No projects exist yet. Create one now?')) openProjectModal();
        return;
    }
    document.getElementById('project-assign-type').value = type;
    document.getElementById('project-assign-id').value = id;
    const select = document.getElementById('project-assign-select');
    select.innerHTML = appState.projects.map(p => `<option value="${p.project_id}" ${p.project_id === appState.activeProjectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
    setInlineResult('project-assign-msg', '');
    openModal('project-assign-modal');
}

async function confirmProjectAssignment() {
    const type = document.getElementById('project-assign-type').value;
    const id = document.getElementById('project-assign-id').value;
    const projectId = parseInt(document.getElementById('project-assign-select').value, 10);
    if (!projectId || !id) return;
    try {
        const path = type === 'annotation'
            ? `/api/projects/${projectId}/annotations`
            : `/api/projects/${projectId}/items`;
        const body = type === 'annotation'
            ? { annotation_id: parseInt(id, 10) }
            : { item_key: id };
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not add to project');
        closeModal('project-assign-modal');
        appState.activeProjectId = projectId;
        await loadProjects({ listOnly: true });
        if (appState.activeCenterView === 'projects') await loadProjectDetail(projectId);
    } catch (err) {
        setInlineResult('project-assign-msg', err.message, 'error');
    }
}

async function removeItemFromProject(itemKey) {
    if (!appState.activeProjectId || !confirm('Remove this source from the project?')) return;
    try {
        await fetch(`/api/projects/${appState.activeProjectId}/items/${encodeURIComponent(itemKey)}`, { method: 'DELETE' });
        await loadProjectDetail(appState.activeProjectId);
    } catch (err) {
        alert('Could not remove source.');
    }
}

async function pinAnnotationToActiveProject(annotationId) {
    if (!appState.activeProjectId) {
        await openProjectAssignModal('annotation', annotationId);
        return;
    }
    await fetch(`/api/projects/${appState.activeProjectId}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotation_id: annotationId }),
    });
    await loadProjectDetail(appState.activeProjectId);
}

async function removeAnnotationFromProject(annotationId) {
    if (!appState.activeProjectId) return;
    await fetch(`/api/projects/${appState.activeProjectId}/annotations/${annotationId}`, { method: 'DELETE' });
    await loadProjectDetail(appState.activeProjectId);
}

async function attachThemeRootToProject() {
    if (!appState.activeProjectId) return;
    const select = document.getElementById('project-theme-root-select');
    const tagId = parseInt(select?.value || '', 10);
    if (!tagId) return;
    try {
        const res = await fetch(`/api/projects/${appState.activeProjectId}/theme-roots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag_id: tagId, include_descendants: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not attach theme root');
        await loadProjectDetail(appState.activeProjectId);
    } catch (err) {
        alert(err.message || 'Could not attach theme root.');
    }
}

async function removeThemeRootFromProject(tagId) {
    if (!appState.activeProjectId) return;
    if (!confirm('Detach this root theme from the project codebook?\n\nThe global theme and existing annotation tags will not be deleted.')) return;
    try {
        const res = await fetch(`/api/projects/${appState.activeProjectId}/theme-roots/${tagId}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not detach theme root');
        await loadProjectDetail(appState.activeProjectId);
    } catch (err) {
        alert(err.message || 'Could not detach theme root.');
    }
}

async function fetchThemeSuggestions(annotationId) {
    const res = await fetch(`/api/annotations/${annotationId}/theme-suggestions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: appState.activeProjectId || null, limit: 6 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'Could not suggest themes');
    return data.suggestions || [];
}

function renderReviewSuggestions(annotationId, suggestions) {
    const el = document.getElementById(`coding-suggestions-${annotationId}`);
    if (!el) return;
    if (!suggestions.length) {
        el.innerHTML = '<span class="project-muted">No suggestion</span>';
        return;
    }
    el.innerHTML = suggestions.map(s => `
        <button class="coding-suggestion-chip" style="--theme-color:${s.color || '#3b82f6'}"
                onclick="acceptThemeSuggestion(${annotationId}, ${s.tag_id})"
                title="${escapeHtml((s.matched_terms || []).join(', '))}">
            #${escapeHtml(s.name)} <small>${s.confidence_percent}%</small>
        </button>
    `).join('');
    refreshIcons(el);
}

async function suggestThemesForReviewRow(annotationId) {
    const el = document.getElementById(`coding-suggestions-${annotationId}`);
    if (el) el.innerHTML = '<span class="project-muted">Checking...</span>';
    try {
        renderReviewSuggestions(annotationId, await fetchThemeSuggestions(annotationId));
    } catch (err) {
        if (el) el.innerHTML = `<span class="project-muted">${escapeHtml(err.message || 'Failed')}</span>`;
    }
}

async function suggestAllProjectReviewThemes() {
    const ids = Array.from(document.querySelectorAll('[data-review-ann-id]'))
        .map(el => parseInt(el.dataset.reviewAnnId, 10))
        .filter(Boolean);
    for (const id of ids.slice(0, 40)) {
        await suggestThemesForReviewRow(id);
    }
}

async function acceptThemeSuggestion(annotationId, tagId) {
    const ann = appState.activeProject?.annotations?.find(a => a.annotation_id === annotationId)
        || appState.annotationsViewItems.find(a => a.annotation_id === annotationId);
    const existing = (ann?.tags || []).map(t => t.tag_id);
    const tagIds = Array.from(new Set([...existing, tagId]));
    try {
        const res = await fetch(`/api/annotations/${annotationId}/tags`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag_ids: tagIds }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not apply theme');
        await loadAllTags({ force: true });
        if (appState.activeCenterView === 'projects' && appState.activeProjectId) await loadProjectDetail(appState.activeProjectId);
        if (appState.previewItem) await loadAnnotations(appState.previewItem.item_key);
    } catch (err) {
        alert(err.message || 'Could not apply theme.');
    }
}

async function autoCodeReviewAnnotation(annotationId) {
    try {
        const res = await fetch(`/api/annotations/${annotationId}/auto-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: appState.activeProjectId || null, min_confidence: 0.85 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not auto-code annotation');
        if (data.applied?.length) {
            await loadAllTags({ force: true });
            if (appState.activeProjectId) await loadProjectDetail(appState.activeProjectId);
        } else {
            renderReviewSuggestions(annotationId, data.suggestions || []);
        }
    } catch (err) {
        alert(err.message || 'Could not auto-code annotation.');
    }
}

async function autoCodeProjectReviewVisible() {
    const ids = Array.from(document.querySelectorAll('[data-review-ann-id]'))
        .map(el => parseInt(el.dataset.reviewAnnId, 10))
        .filter(Boolean);
    let applied = 0;
    for (const id of ids.slice(0, 40)) {
        const res = await fetch(`/api/annotations/${id}/auto-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: appState.activeProjectId || null, min_confidence: 0.85 }),
        });
        if (res.ok) {
            const data = await res.json();
            if (data.applied?.length) applied += 1;
        }
    }
    if (applied) {
        await loadAllTags({ force: true });
        if (appState.activeProjectId) await loadProjectDetail(appState.activeProjectId);
    } else {
        alert('No visible annotations met the 85% auto-code threshold.');
    }
}

async function suggestThemesForAnnotation(annotationId) {
    try {
        const suggestions = await fetchThemeSuggestions(annotationId);
        if (!suggestions.length) {
            alert('No strong theme suggestions yet. Add more coded examples or theme descriptions to improve suggestions.');
            return;
        }
        const lines = suggestions.map(s => `#${s.name} (${s.confidence_percent}%) - ${s.reason}`).join('\n');
        const apply = confirm(`Suggested themes:\n\n${lines}\n\nApply suggestions with confidence 85% or higher?`);
        if (!apply) return;
        const applyRes = await fetch(`/api/annotations/${annotationId}/auto-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: appState.activeProjectId || null, min_confidence: 0.85 }),
        });
        const result = await applyRes.json();
        if (!applyRes.ok) throw new Error(result.detail || 'Could not apply themes');
        if (result.applied?.length) {
            if (appState.previewItem) await loadAnnotations(appState.previewItem.item_key);
            if (appState.activeCenterView === 'annotations') await loadAnnotationsViewData();
            if (appState.activeCenterView === 'projects' && appState.activeProjectId) await loadProjectDetail(appState.activeProjectId);
            alert(`Applied: ${result.applied.map(t => '#' + t.name).join(', ')}`);
        } else {
            alert('No suggestions met the 85% auto-apply threshold.');
        }
    } catch (err) {
        alert(err.message || 'Theme suggestion failed.');
    }
}
