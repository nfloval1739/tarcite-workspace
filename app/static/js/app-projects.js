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

/* Both the PNG and the SVG come from one generated drawing, so they cannot
   disagree.  The PNG used to be `canvas.toDataURL()`: it captured whatever pan
   and zoom happened to be active, at the canvas' own CSS size — roughly 1500px
   wide and useless in print — and cropped every theme name that had settled
   near the edge of the box. */
function exportProjectNetworkPng() {
    _exportChart(_buildNetworkSvg, 'theme_network', 'png', _NO_CHART);
}

function exportProjectNetworkSvg() {
    _exportChart(_buildNetworkSvg, 'theme_network', 'svg', _NO_CHART);
}

function exportProjectSaturationData() {
    const rows = _saturationRows(_projectAnalysisAnnotations());
    if (!rows.length) { alert('No saturation data to export.'); return; }
    _downloadTextFile(`theme_saturation_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`, '\ufeff' + _csv([
        ['annotation_index', 'annotation_id', 'source', 'page', 'themes_on_annotation', 'new_themes', 'new_theme_count', 'cumulative_themes'],
        ...rows.map(r => [r.annotation_index, r.annotation_id, r.source, r.page, r.themes_on_annotation, r.new_themes, r.new_theme_count, r.cumulative_themes]),
    ]), 'text/csv;charset=utf-8;');
}

/* Every ranked candidate, not just the one on screen: the card shows one
   exemplar per theme, but choosing between them is the researcher's job and the
   file is where that choice gets made. */
function exportProjectExemplarsData() {
    const exemplars = _exemplarsFor(_projectAnalysisAnnotations());
    if (!exemplars.length) { alert('No exemplar quotes to export.'); return; }
    const rows = exemplars.flatMap(e => e.candidates.map((c, i) => [
        e.tag.name, i + 1, e.candidates.length, c.score.toFixed(4),
        c.terms.join('; '), c.text,
        c.a.item_title || c.a.item_key, c.a.item_year || '', (c.a.page_index || 0) + 1,
        c.a.annotation_id,
    ]));
    _downloadTextFile(`exemplar_quotes_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`, '﻿' + _csv([
        ['theme', 'rank', 'candidates_in_theme', 'score', 'matched_terms', 'text', 'source', 'year', 'page', 'annotation_id'],
        ...rows,
    ]), 'text/csv;charset=utf-8;');
}

/* Both selections' labels travel with the numbers: a comparison CSV that does
   not say what A and B were is unreadable a week later. */
function exportProjectComparisonData() {
    const { rows, codedA, codedB, overlap } = _comparisonRows();
    if (!rows.length) { alert('Capture two selections first.'); return; }
    _downloadTextFile(`theme_comparison_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`, '﻿' + _csv([
        ['selection_a', _abSets.A?.label || '', 'coded_annotations_a', codedA],
        ['selection_b', _abSets.B?.label || '', 'coded_annotations_b', codedB],
        ['annotations_in_both', overlap],
        [],
        ['theme', 'count_a', 'share_a_pct', 'count_b', 'share_b_pct', 'difference_pp'],
        ...rows.map(r => [r.tag.name, r.nA, r.pA.toFixed(1), r.nB, r.pB.toFixed(1), r.diff.toFixed(1)]),
    ]), 'text/csv;charset=utf-8;');
}

/* ── Chart image export ───────────────────────────────────────────────────────
   Every image below is *generated* from the analysis data rather than scraped
   out of the rendered card.  A DOM copy carries CSS custom properties,
   stylesheet classes and the card header's inline Lucide icon, and none of them
   survive the trip into a file: `[data-analysis-card="saturation"] svg` matched
   the header's 24px "activity" glyph first, so that is what the saturation and
   sentiment exports contained.  Generating the file also lets every label be
   measured before it is placed, which a header height guessed at 54px in
   advance could not do for the matrix's rotated column titles.              */

const _EXP = {
    bg: '#ffffff',
    panel: '#f8fafc',
    ink: '#0f172a',
    body: '#334155',
    muted: '#64748b',
    grid: '#e2e8f0',
    rule: '#cbd5e1',
    accent: '#2d6fd4',
    font: 'Helvetica, Arial, sans-serif',
    pad: 22,
};

// Escape text for SVG/XML text nodes (&, <, >, " must become entities)
const _sx = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Real advance widths, so a label is trimmed to the space it has rather than to
   a character count.  "Institutional Support" and "Coping Strategies" differ by
   four characters and by 30 pixels; the fixed-character cut left one label
   floating in white space and let the other run into the next column. */
let _expMeasureCtx = null;
function _tw(text, size, weight = 400) {
    if (!_expMeasureCtx) _expMeasureCtx = document.createElement('canvas').getContext('2d');
    _expMeasureCtx.font = `${weight} ${size}px ${_EXP.font}`;
    return _expMeasureCtx.measureText(String(text ?? '')).width;
}

function _ellipsize(text, size, maxPx, weight = 400) {
    const s = String(text ?? '');
    if (!s || _tw(s, size, weight) <= maxPx) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (_tw(s.slice(0, mid) + '…', size, weight) <= maxPx) lo = mid; else hi = mid - 1;
    }
    return lo ? s.slice(0, lo).trimEnd() + '…' : '…';
}

function _analysisSourceLabel() {
    return _analysisSource === 'library'
        ? 'Library — all annotations'
        : (appState.activeProject?.name || 'Project');
}

/* One frame for every card: title, subtitle, the drawing, and a provenance line
   saying which corpus and which moment produced it.  A chart in a supervision
   meeting that cannot say what it is a picture of is not evidence. */
function _expFrame({ title, subtitle, bodyW, bodyH, body }) {
    const pad = _EXP.pad;
    const titleH = 21;
    const headH = titleH + (subtitle ? 16 : 0) + 12;
    const footH = 16;
    const stamp = `${_analysisSourceLabel()} · exported ${new Date().toLocaleString('en-GB')}`;
    const W = Math.ceil(Math.max(bodyW, _tw(title, 16, 700), _tw(subtitle || '', 11), _tw(stamp, 9)) + pad * 2);
    const H = Math.ceil(headH + bodyH + footH + pad * 2);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${_EXP.bg}"/>
<g font-family="${_EXP.font}">
<text x="${pad}" y="${pad + 15}" font-size="16" font-weight="700" fill="${_EXP.ink}">${_sx(title)}</text>
${subtitle ? `<text x="${pad}" y="${pad + titleH + 12}" font-size="11" fill="${_EXP.muted}">${_sx(subtitle)}</text>` : ''}
<g transform="translate(${pad}, ${pad + headH})">${body}</g>
<text x="${pad}" y="${H - pad + 2}" font-size="9" fill="${_EXP.muted}">${_sx(stamp)}</text>
</g></svg>`;
}

/* Read the size the markup declares.  An inline chart carries only a viewBox,
   and an <img> loading such an SVG reports naturalWidth 0 in WebKit — which is
   how a PNG export ends up as a blank or icon-sized file. */
function _svgDeclaredSize(svgText) {
    const w = /\swidth="([\d.]+)"/.exec(svgText);
    const h = /\sheight="([\d.]+)"/.exec(svgText);
    if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
    const vb = /viewBox="([-\d.\s]+)"/.exec(svgText);
    if (vb) {
        const p = vb[1].trim().split(/[\s,]+/).map(Number);
        if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] };
    }
    return null;
}

/* Charts are authored at screen size, so a flat 2× raster is ~1000px wide — fine
   on a slide, soft in a printed thesis at 300 dpi.  Scale to a target width
   instead, so a small chart is upsampled more than a wide one and every export
   lands in the same usable band. */
const _PNG_TARGET_W = 2600;
const _PNG_MAX_PX = 40e6;   // canvas area guard: WebKit silently fails past ~2^25 px

function _svgAsPng(svgText, filename, opts = {}) {
    const declared = _svgDeclaredSize(svgText);
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
        const baseW = img.naturalWidth || declared?.w || 0;
        const baseH = img.naturalHeight || declared?.h || 0;
        if (!baseW || !baseH) {
            URL.revokeObjectURL(url);
            alert('Image export failed: the chart reported no size.');
            return;
        }
        let scale = Math.min(opts.maxScale ?? 10, Math.max(opts.minScale ?? 2, (opts.targetWidth ?? _PNG_TARGET_W) / baseW));
        if (baseW * baseH * scale * scale > _PNG_MAX_PX) scale = Math.sqrt(_PNG_MAX_PX / (baseW * baseH));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(baseW * scale);
        canvas.height = Math.round(baseH * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = opts.background || _EXP.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.drawImage(img, 0, 0, baseW, baseH);
        URL.revokeObjectURL(url);
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = filename;
        a.click();
    };
    img.onerror = () => { URL.revokeObjectURL(url); alert('Image export failed.'); };
    img.src = url;
}

/* Find the chart inside a card, skipping the header's Lucide icon.  Kept for
   callers that still want the on-screen element; the exporters no longer use
   it, because scraping the DOM was the whole source of the icon-sized files. */
function _analysisCardSvg(card) {
    const root = document.querySelector(`${_analysisContainerSelector()} [data-analysis-card="${card}"]`);
    if (!root) return null;
    return Array.from(root.querySelectorAll('svg')).find(s => !s.classList.contains('lucide')) || null;
}

/* Shared horizontal bar list: label column, track, value.  Used by theme
   frequency, word frequency and co-occurrence so the three read as one family. */
function _expBars(rows, opts = {}) {
    const LBL = opts.labelSize ?? 11;
    const rowH = opts.rowH ?? 24;
    const barMaxW = opts.barMaxW ?? 420;
    const labelCap = opts.labelCap ?? 210;
    const swatch = rows.some(r => r.swatch) ? 9 : 0;
    const labels = rows.map(r => _ellipsize(r.label, LBL, labelCap));
    const labelW = Math.ceil(Math.max(10, ...labels.map(s => _tw(s, LBL))) + swatch + (swatch ? 20 : 12));
    const valueTexts = rows.map(r => r.valueText ?? String(r.value));
    const valueW = Math.ceil(Math.max(...valueTexts.map(s => _tw(s, 10, 600))) + 8);
    const max = Math.max(...rows.map(r => r.value), opts.max ?? 0) || 1;
    const bodyW = labelW + barMaxW + valueW;
    const bodyH = rows.length * rowH;
    const body = rows.map((r, i) => {
        const y = i * rowH;
        const bw = Math.max(1, (r.value / max) * barMaxW);
        const fill = r.gradient
            ? `url(#g${i})`
            : (r.color || _EXP.accent);
        const grad = r.gradient
            ? `<defs><linearGradient id="g${i}" x1="0" x2="1"><stop offset="0" stop-color="${r.gradient[0]}"/><stop offset="1" stop-color="${r.gradient[1]}"/></linearGradient></defs>`
            : '';
        return grad +
            (swatch ? `<rect x="${labelW - swatch - 8}" y="${y + (rowH - swatch) / 2}" width="${swatch}" height="${swatch}" rx="2" fill="${r.swatch || _EXP.accent}"/>` : '') +
            `<text x="${labelW - swatch - (swatch ? 14 : 10)}" y="${y + rowH / 2}" text-anchor="end" dominant-baseline="central" font-size="${LBL}" fill="${_EXP.ink}">${_sx(labels[i])}</text>` +
            `<rect x="${labelW}" y="${y + 4}" width="${barMaxW}" height="${rowH - 8}" rx="3" fill="${_EXP.panel}"/>` +
            `<rect x="${labelW}" y="${y + 4}" width="${bw.toFixed(1)}" height="${rowH - 8}" rx="3" fill="${fill}" fill-opacity="0.9"/>` +
            `<text x="${labelW + barMaxW + 6}" y="${y + rowH / 2}" dominant-baseline="central" font-size="10" font-weight="600" fill="${_EXP.muted}">${_sx(valueTexts[i])}</text>`;
    }).join('');
    return { body, bodyW, bodyH };
}

/* ── Builders ────────────────────────────────────────────────────────────────*/

function _buildThemeFrequencySvg() {
    const items = _projectAnalysisAnnotations();
    const counts = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!counts[t.tag_id]) counts[t.tag_id] = { name: t.name, color: t.color, count: 0 };
        counts[t.tag_id].count++;
    }));
    const all = Object.values(counts).sort((a, b) => b.count - a.count);
    const sorted = all.slice(0, 15);
    if (!sorted.length) return null;
    const { body, bodyW, bodyH } = _expBars(sorted.map(t => ({
        label: t.name, value: t.count, color: t.color || _EXP.accent, swatch: t.color || _EXP.accent,
    })));
    return _expFrame({
        title: 'Theme Frequency',
        subtitle: `annotations carrying each theme${sorted.length < all.length ? ` · showing top ${sorted.length} of ${all.length}` : ''}`,
        bodyW, bodyH, body,
    });
}

/* The card has three views and each carries a different reading of the same
   counts — ranked bars for comparing magnitudes, a cloud for the overall shape
   of the vocabulary, a tile flow for relative mass.  Exporting bars whatever was
   on screen handed back a picture the researcher had already chosen against, so
   the file follows the view, and follows the truncation that view applies. */
function _wfActiveMode() {
    const mode = _analysisSource === 'library' ? _wfMode : _projWfMode;
    return ['bars', 'cloud', 'treemap'].includes(mode) ? mode : 'bars';
}

const _WF_SHOWN = { bars: 20, cloud: 30, treemap: 25 };

function _buildWordFrequencySvg() {
    const rows = _wordFrequencyRows();
    if (!rows.length) return null;
    const mode = _wfActiveMode();
    const shown = rows.slice(0, _WF_SHOWN[mode]);
    const max = shown[0][1];
    const drawn = mode === 'cloud' ? _wfCloudBody(shown, max)
        : mode === 'treemap' ? _wfTreemapBody(shown, max)
        : _expBars(shown.map(([w, n]) => ({ label: w, value: n })));
    const how = { bars: 'ranked bars', cloud: 'word cloud — type size = count', treemap: 'tile flow — tile area = count' }[mode];
    return _expFrame({
        title: 'Word Frequency',
        subtitle: `content words in quotes and notes, stop words removed · ${how} · showing top ${shown.length} of ${rows.length} distinct`,
        bodyW: drawn.bodyW, bodyH: drawn.bodyH, body: drawn.body,
    });
}

/* Both flowing views wrap like the flex containers they mirror: fill a row until
   the next item will not fit, then drop to a new one.  Measuring each item first
   is what keeps a long word from running past the edge of the page. */
function _wfFlow(items, maxW, gapX, gapY) {
    const rows = [];
    let row = [], x = 0;
    items.forEach(it => {
        if (row.length && x + it.w > maxW) { rows.push({ items: row, w: x - gapX }); row = []; x = 0; }
        row.push({ ...it, x });
        x += it.w + gapX;
    });
    if (row.length) rows.push({ items: row, w: x - gapX });
    let y = 0;
    rows.forEach(r => { r.y = y; r.h = Math.max(...r.items.map(i => i.h)); y += r.h + gapY; });
    return { rows, width: Math.max(...rows.map(r => r.w)), height: y - gapY };
}

function _wfCloudBody(shown, max) {
    const MIN = 13, MAX = 44, WRAP = 680;
    const items = shown.map(([w, n]) => {
        const ratio = n / max;
        const size = Math.round(MIN + (MAX - MIN) * ratio);
        const weight = ratio > 0.55 ? 700 : ratio > 0.25 ? 500 : 400;
        return { w: _tw(w, size, weight), h: Math.round(size * 1.3), word: w, n, size, weight, ratio };
    });
    const { rows, width, height } = _wfFlow(items, WRAP, 14, 10);
    const body = rows.map(r => r.items.map(it => {
        // Rows are centred on their tallest word, as `align-items: center` does.
        const y = r.y + r.h / 2;
        const opacity = (0.45 + 0.55 * it.ratio).toFixed(2);
        return `<text x="${it.x.toFixed(1)}" y="${y.toFixed(1)}" dominant-baseline="central" font-size="${it.size}" font-weight="${it.weight}" fill="${_EXP.accent}" fill-opacity="${opacity}">${_sx(it.word)}</text>` +
            `<title>${_sx(it.word)}: ${it.n}</title>`;
    }).join('')).join('');
    return { body, bodyW: width, bodyH: height };
}

function _wfTreemapBody(shown, max) {
    const WRAP = 680, WORD = 12, COUNT = 10, PAD = 10;
    const items = shown.map(([w, n]) => {
        const ratio = n / max;
        const width = Math.max(56, (Math.max(8, ratio * 92) / 100) * WRAP - 4);
        return { w: width, h: Math.round(40 + ratio * 40), word: w, n, ratio, tileW: width };
    });
    const { rows, width, height } = _wfFlow(items, WRAP, 4, 4);
    const body = rows.map(r => r.items.map(it => {
        const label = _ellipsize(it.word, WORD, it.tileW - PAD * 2, 600);
        const cx = it.x + it.tileW / 2;
        const opacity = (0.45 + 0.55 * it.ratio).toFixed(2);
        return `<rect x="${it.x.toFixed(1)}" y="${r.y}" width="${it.tileW.toFixed(1)}" height="${it.h}" rx="5" fill="${_EXP.accent}" fill-opacity="${opacity}"/>` +
            `<text x="${cx.toFixed(1)}" y="${r.y + it.h / 2 - 6}" text-anchor="middle" dominant-baseline="central" font-size="${WORD}" font-weight="600" fill="#ffffff">${_sx(label)}</text>` +
            `<text x="${cx.toFixed(1)}" y="${r.y + it.h / 2 + 9}" text-anchor="middle" dominant-baseline="central" font-size="${COUNT}" fill="#ffffff" fill-opacity="0.75">${it.n}</text>`;
    }).join('')).join('');
    return { body, bodyW: width, bodyH: height };
}

function _buildCoOccurrenceSvg() {
    const { pairs, metric } = _coOccurrenceRows();
    if (!pairs.length) return null;
    const shown = pairs.slice(0, 12);
    const { body, bodyW, bodyH } = _expBars(shown.map(p => ({
        label: `${p.a.name} × ${p.b.name}`,
        value: metric === 'jaccard' ? p.jaccard : p.count,
        valueText: metric === 'jaccard' ? `${p.jaccard.toFixed(2)}  n=${p.count}` : String(p.count),
        gradient: [p.a.color || _EXP.accent, p.b.color || _EXP.accent],
    })), { labelCap: 260 });
    return _expFrame({
        title: 'Theme Co-occurrence',
        subtitle: (metric === 'jaccard'
            ? 'Jaccard index — shared annotations ÷ annotations carrying either theme'
            : 'raw count of annotations carrying both themes') +
            (shown.length < pairs.length ? ` · showing top ${shown.length} of ${pairs.length} pairs` : ''),
        bodyW, bodyH, body,
    });
}

/* One strip of pages per document, cell shade = annotations on that page.  The
   strip is given a fixed width and the cell width falls out of the longest
   document, so two documents of different lengths stay comparable left to
   right instead of each being stretched to fill the row. */
function _buildCodingDensitySvg() {
    const docs = _codingDensityDocs();
    if (!docs.length) return null;
    const shown = docs.slice(0, 12);
    const LBL = 11, rowH = 26, stripW = 560;
    const maxPages = Math.max(...shown.map(d => d.maxPage + 1));
    const cellW = Math.max(2, Math.min(14, stripW / maxPages));
    // The strip is only as wide as the pages actually drawn, so the totals sit
    // beside the data instead of at the end of a slot the cells never reached.
    const usedW = Math.ceil(maxPages * cellW);
    const labels = shown.map(d => _ellipsize(d.title, LBL, 220));
    const labelW = Math.ceil(Math.max(...labels.map(s => _tw(s, LBL))) + 12);
    const totalW = Math.ceil(Math.max(...shown.map(d => _tw(String(d.total), 10, 600))) + 10);
    const gridTop = 16;
    const bodyW = labelW + usedW + totalW + 8;
    const bodyH = gridTop + shown.length * rowH + 18;

    const rows = shown.map((d, i) => {
        const y = gridTop + i * rowH;
        const cells = [];
        for (let p = 0; p <= d.maxPage; p++) {
            const c = d.pages[p] || 0;
            const op = c ? (0.18 + (c / d.maxCount) * 0.8) : 0.05;
            cells.push(`<rect x="${(labelW + p * cellW).toFixed(2)}" y="${y + 4}" width="${Math.max(1, cellW - 0.8).toFixed(2)}" height="${rowH - 9}" fill="${_EXP.accent}" fill-opacity="${op.toFixed(2)}"/>`);
        }
        return `<text x="${labelW - 10}" y="${y + rowH / 2}" text-anchor="end" dominant-baseline="central" font-size="${LBL}" fill="${_EXP.body}">${_sx(labels[i])}</text>` +
            cells.join('') +
            `<text x="${labelW + usedW + 8}" y="${y + rowH / 2}" dominant-baseline="central" font-size="10" font-weight="600" fill="${_EXP.muted}">${d.total}</text>`;
    }).join('');

    // A page ruler, so "the coding is all at the front" can be read off the axis
    // rather than inferred from the length of the strip.
    const tickEvery = Math.max(1, Math.ceil(maxPages / 12));
    const ticks = [];
    for (let p = 0; p < maxPages; p += tickEvery) {
        const x = labelW + p * cellW + cellW / 2;
        ticks.push(`<text x="${x.toFixed(1)}" y="${gridTop + shown.length * rowH + 12}" text-anchor="middle" font-size="9" fill="${_EXP.muted}">${p + 1}</text>`);
    }
    const header = '';
    return _expFrame({
        title: 'Coding Density per Page',
        subtitle: `each cell = one page, shade = annotation count · ${shown.length === docs.length ? shown.length : `top ${shown.length} of ${docs.length}`} document${docs.length !== 1 ? 's' : ''}, most-coded first · page number along the foot`,
        bodyW, bodyH, body: header + rows + ticks.join(''),
    });
}

function _buildSaturationSvg() {
    const items = _projectAnalysisAnnotations();
    if (!items.length) return null;
    const s = _saturationSeries(items);
    const { rows, lastNew, sinceLastNew, window: win, tooSmall, isSat, uncoded } = s;
    const maxT = s.themes;
    if (!maxT || !rows.length) return null;

    const axisL = 46, axisB = 34, plotW = 720, plotH = 250;
    const statH = 54;
    const bodyW = axisL + plotW;
    const bodyH = plotH + axisB + statH;
    const toX = n => axisL + (n / rows.length) * plotW;
    const toY = t => plotH - (t / maxT) * plotH;

    const step = Math.max(1, Math.floor(rows.length / 600));
    const pts = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
    const poly = pts.map(d => `${toX(d.n).toFixed(1)},${toY(d.total).toFixed(1)}`).join(' ');
    const area = `${toX(0).toFixed(1)},${plotH} ${poly} ${toX(rows.length).toFixed(1)},${plotH}`;

    const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
        const y = toY(maxT * f).toFixed(1);
        return `<line x1="${axisL}" y1="${y}" x2="${axisL + plotW}" y2="${y}" stroke="${_EXP.grid}" stroke-width="1"${f ? ' stroke-dasharray="3 3"' : ''}/>` +
            `<text x="${axisL - 8}" y="${y}" text-anchor="end" dominant-baseline="central" font-size="10" fill="${_EXP.muted}">${Math.round(maxT * f)}</text>`;
    }).join('');

    const xTicks = [];
    const tickCount = Math.min(8, rows.length);
    for (let i = 0; i <= tickCount; i++) {
        const n = Math.round((i / tickCount) * rows.length) || 1;
        const x = toX(n).toFixed(1);
        xTicks.push(`<line x1="${x}" y1="${plotH}" x2="${x}" y2="${plotH + 4}" stroke="${_EXP.rule}" stroke-width="1"/>` +
            `<text x="${x}" y="${plotH + 16}" text-anchor="middle" font-size="10" fill="${_EXP.muted}">${n}</text>`);
    }

    const satX = toX(lastNew + 1);
    const satLine = isSat ? `
        <line x1="${satX.toFixed(1)}" y1="0" x2="${satX.toFixed(1)}" y2="${plotH}" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="5 4"/>
        <rect x="${(satX - 34).toFixed(1)}" y="2" width="68" height="16" rx="3" fill="#16a34a" fill-opacity="0.12"/>
        <text x="${satX.toFixed(1)}" y="10" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="700" fill="#16a34a">saturation</text>` : '';

    const stats = [
        [String(maxT), _analysisRollup === 'root' ? 'top-level themes used' : 'themes used (as coded)'],
        [`#${lastNew + 1} / ${rows.length}`, 'last new theme introduced at'],
        [String(sinceLastNew), `coded annotations since, criterion ≥ ${win}`],
        [tooSmall ? 'Too early' : isSat ? 'Saturated' : 'In progress',
         tooSmall ? `need ≥ 15 coded annotations to judge (have ${rows.length})`
             : isSat ? `no new theme in the last ${sinceLastNew}`
             : `${win - sinceLastNew} more without a new theme to qualify`],
    ];
    const statW = bodyW / stats.length;
    const statBody = stats.map(([big, small], i) => {
        const x = i * statW + 10;
        const colour = i === 3 ? (tooSmall ? _EXP.muted : isSat ? '#16a34a' : _EXP.accent) : _EXP.ink;
        return `<text x="${x}" y="${plotH + axisB + 16}" font-size="14" font-weight="700" fill="${colour}">${_sx(big)}</text>` +
            `<text x="${x}" y="${plotH + axisB + 32}" font-size="9" fill="${_EXP.muted}">${_sx(_ellipsize(small, 9, statW - 16))}</text>`;
    }).join('');

    const body = `
        ${grid}
        <polygon points="${area}" fill="${_EXP.accent}" fill-opacity="0.10"/>
        <polyline points="${poly}" fill="none" stroke="${_EXP.accent}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
        ${satLine}
        <line x1="${axisL}" y1="${plotH}" x2="${axisL + plotW}" y2="${plotH}" stroke="${_EXP.rule}" stroke-width="1"/>
        ${xTicks.join('')}
        <text x="${(axisL + plotW / 2).toFixed(1)}" y="${plotH + 30}" text-anchor="middle" font-size="10" fill="${_EXP.muted}">coded annotation #</text>
        <text x="12" y="${(plotH / 2).toFixed(1)}" transform="rotate(-90 12 ${(plotH / 2).toFixed(1)})" text-anchor="middle" font-size="10" fill="${_EXP.muted}">cumulative themes</text>
        <line x1="0" y1="${plotH + axisB - 6}" x2="${bodyW}" y2="${plotH + axisB - 6}" stroke="${_EXP.grid}" stroke-width="1"/>
        ${statBody}`;

    return _expFrame({
        title: 'Theme Saturation Curve',
        subtitle: `cumulative new themes in coding order · saturation = no new theme for ${win}+ consecutive coded annotations${
            uncoded ? ` · measured over ${rows.length} coded annotation${rows.length !== 1 ? 's' : ''}, ${uncoded} uncoded excluded` : ''}`,
        bodyW, bodyH, body,
    });
}

function _buildSentimentSvg() {
    const items = _projectAnalysisAnnotations();
    if (!items.length) return null;
    const { tagged, segs, total, manualCount, none } = _sentimentBreakdown(items);
    if (!total) return null;

    const R = 74, SW = 30, cx = R + SW / 2, cy = R + SW / 2;
    const circ = 2 * Math.PI * R;
    let off = 0;
    const arcs = segs.map(s => {
        const dash = (s.count / total) * circ;
        const el = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${SW}"
            stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
            transform="rotate(-90 ${cx} ${cy})"/>`;
        off += dash;
        return el;
    }).join('');
    const donutW = (R + SW / 2) * 2;

    const legendX = donutW + 28;
    const legend = segs.map((s, i) => {
        const y = 14 + i * 22;
        return `<rect x="${legendX}" y="${y - 6}" width="11" height="11" rx="2" fill="${s.color}"/>` +
            `<text x="${legendX + 18}" y="${y}" dominant-baseline="central" font-size="11" fill="${_EXP.body}">${_sx(s.label)}</text>` +
            `<text x="${legendX + 118}" y="${y}" dominant-baseline="central" font-size="11" font-weight="600" fill="${_EXP.ink}">${s.count} · ${(s.count / total * 100).toFixed(0)}%</text>`;
    }).join('');
    const legendW = 200;

    // Per-theme split: the donut says how the corpus reads overall, this says
    // which themes carry the negative material — the question actually asked of
    // a sentiment breakdown in a thesis.
    const themes = _sentimentThemes(tagged).slice(0, 10);
    const barTop = Math.max(donutW, 14 + segs.length * 22) + 30;
    const LBL = 11, rowH = 24, trackW = 360;
    const tLabels = themes.map(t => _ellipsize(t.name, LBL, 190));
    const tLabelW = themes.length ? Math.ceil(Math.max(...tLabels.map(s => _tw(s, LBL))) + 29) : 0;
    const themeBody = themes.map((t, i) => {
        const y = barTop + 16 + i * rowH;
        let x = tLabelW;
        const segParts = [
            ['pos', '#22c55e'], ['neu', '#94a3b8'], ['neg', '#ef4444'], ['none', '#94a3b8'],
        ].map(([k, colour]) => {
            const w = (t[k] / t.total) * trackW;
            if (w <= 0) return '';
            const el = `<rect x="${x.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 9}" fill="${colour}" fill-opacity="${k === 'none' ? 0.3 : 0.9}"/>`;
            x += w;
            return el;
        }).join('');
        return `<rect x="${tLabelW - 17}" y="${y + (rowH - 9) / 2}" width="9" height="9" rx="2" fill="${t.color || _EXP.accent}"/>` +
            `<text x="${tLabelW - 23}" y="${y + rowH / 2}" text-anchor="end" dominant-baseline="central" font-size="${LBL}" fill="${_EXP.ink}">${_sx(tLabels[i])}</text>` +
            segParts +
            `<text x="${tLabelW + trackW + 6}" y="${y + rowH / 2}" dominant-baseline="central" font-size="10" font-weight="600" fill="${_EXP.muted}">${t.total}</text>`;
    }).join('');
    const themeHeader = themes.length
        ? `<text x="0" y="${barTop + 4}" font-size="10" font-weight="700" fill="${_EXP.ink}">By theme — positive · neutral · negative · not scored</text>` : '';

    const bodyW = Math.max(legendX + legendW, tLabelW + trackW + 34);
    const bodyH = themes.length ? barTop + 16 + themes.length * rowH : barTop;
    const body = `${arcs}
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="26" font-weight="700" fill="${_EXP.ink}">${total}</text>
        ${legend}${themeHeader}${themeBody}`;

    const inferred = total - manualCount;
    const parts = [];
    if (manualCount) parts.push(`${manualCount} manually flagged`);
    if (inferred) parts.push(`${inferred} keyword-scored from quote + note`);
    return _expFrame({
        title: 'Annotation Sentiment',
        subtitle: (parts.join(' · ') || 'no annotations to score') +
            (none ? ` · ${none} of ${total} contained no word this lexicon knows, shown as "not scored" rather than neutral` : ''),
        bodyW, bodyH, body,
    });
}

function _buildTFIDFSvg() {
    const themes = _tfidfThemes(6, 6);
    if (!themes.length) return null;
    const cols = Math.min(themes.length, 3);
    const rowsN = Math.ceil(themes.length / cols);
    const colW = 250, gap = 26, headH = 22, rowH = 21, termW = 100;
    const blockH = headH + 6 * rowH;
    const bodyW = cols * colW + (cols - 1) * gap;
    const bodyH = rowsN * blockH + (rowsN - 1) * gap;
    const blocks = themes.map((t, idx) => {
        const bx = (idx % cols) * (colW + gap);
        const by = Math.floor(idx / cols) * (blockH + gap);
        const bars = t.tfidf.map((entry, i) => {
            const y = by + headH + i * rowH;
            const bw = Math.max(1, (entry.score / t.maxScore) * (colW - termW - 10));
            return `<text x="${bx}" y="${y + rowH / 2}" dominant-baseline="central" font-size="10" fill="${_EXP.body}">${_sx(_ellipsize(entry.w, 10, termW - 8))}</text>` +
                `<rect x="${bx + termW}" y="${y + 3}" width="${bw.toFixed(1)}" height="${rowH - 7}" rx="2" fill="${t.color || _EXP.accent}" fill-opacity="0.8"/>`;
        }).join('');
        return `<text x="${bx}" y="${by + 10}" font-size="11" font-weight="700" fill="${t.color || _EXP.accent}">${_sx(_ellipsize(t.name, 11, colW, 700))}</text>${bars}`;
    }).join('');
    return _expFrame({
        title: 'TF-IDF per Theme',
        subtitle: 'terms that distinguish each theme from the others · bar length = TF-IDF score',
        bodyW, bodyH, body: blocks,
    });
}

/* Rotated column titles are the reason this chart is generated rather than
   guessed at.  A label rotated −45° rises L·sin45 above its anchor and reaches
   the same distance to its left; both are measured here, so the titles sit
   clear of the grid instead of lying across the first row of cells, and the
   left overhang is added to the frame instead of being cropped. */
function _buildDocumentMatrixSvg() {
    const items = _projectAnalysisAnnotations();
    const themeCounts = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!themeCounts[t.tag_id]) themeCounts[t.tag_id] = { ...t, c: 0 };
        themeCounts[t.tag_id].c++;
    }));
    const allThemes = Object.values(themeCounts).sort((a, b) => b.c - a.c);
    const topThemes = allThemes.slice(0, 10);

    // The card's own grouping, not a hard-coded "by document": switching the
    // card to Year or Type used to export a picture nobody had looked at.
    const mode = MATRIX_GROUP_LABELS[_matrixGroupBy] ? _matrixGroupBy : 'document';
    const { entries: allDocs } = _matrixGroups(items, mode);
    const topDocs = mode === 'year' ? allDocs : allDocs.slice(0, 8);
    if (!topThemes.length || !topDocs.length) return null;

    const matrix = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!matrix[t.tag_id]) matrix[t.tag_id] = {};
        const k = _matrixGroupOf(a, mode).key;
        matrix[t.tag_id][k] = (matrix[t.tag_id][k] || 0) + 1;
    }));
    const maxVal = Math.max(1, ...topThemes.flatMap(t => topDocs.map(([k]) => matrix[t.tag_id]?.[k] || 0)));

    const LBL = 11, HDR = 10, cellH = 30, cellW = 50, SWATCH = 9;
    const rowLabels = topThemes.map(t => _ellipsize(t.name, LBL, 220));
    const labelW = Math.ceil(Math.max(...rowLabels.map(s => _tw(s, LBL))) + SWATCH + 20);
    const colLabels = topDocs.map(([, title]) => _ellipsize(title, HDR, 150));
    // A label rotated −45° reads up and to the right of its anchor, so it rises
    // L·sin45 above the grid and reaches the same distance past the last column.
    // Both are measured; the old fixed 54px header was shorter than the labels
    // it had to clear, which is why they lay across the first row of cells.
    const diag = Math.max(...colLabels.map(s => _tw(s, HDR))) * Math.SQRT1_2;
    const headerH = Math.ceil(diag) + 8;
    const gridW = topDocs.length * cellW;
    const gridH = topThemes.length * cellH;
    const gridX = labelW;
    const bodyW = gridX + gridW + Math.max(0, Math.ceil(diag - cellW / 2));
    const bodyH = headerH + gridH;

    const headers = colLabels.map((s, i) => {
        const x = (gridX + i * cellW + cellW / 2).toFixed(1);
        const y = (headerH - 6).toFixed(1);
        return `<text x="${x}" y="${y}" transform="rotate(-45 ${x} ${y})" text-anchor="start" font-size="${HDR}" fill="${_EXP.body}">${_sx(s)}</text>`;
    }).join('');

    const rows = topThemes.map((t, ri) => {
        const y = headerH + ri * cellH;
        const cells = topDocs.map(([k], ci) => {
            const v = matrix[t.tag_id]?.[k] || 0;
            const x = gridX + ci * cellW;
            const alpha = v ? 0.15 + (v / maxVal) * 0.75 : 0;
            // White numerals on a 15%-tint cell were unreadable; only invert
            // once the fill is dark enough to carry them.
            const fg = alpha > 0.55 ? '#ffffff' : _EXP.ink;
            return `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="${t.color || _EXP.accent}" fill-opacity="${alpha.toFixed(2)}" stroke="${_EXP.grid}" stroke-width="1"/>` +
                (v ? `<text x="${x + cellW / 2}" y="${y + cellH / 2}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="600" fill="${fg}">${v}</text>` : '');
        }).join('');
        return `<rect x="${gridX - SWATCH - 8}" y="${y + (cellH - SWATCH) / 2}" width="${SWATCH}" height="${SWATCH}" rx="2" fill="${t.color || _EXP.accent}"/>` +
            `<text x="${gridX - SWATCH - 14}" y="${y + cellH / 2}" text-anchor="end" dominant-baseline="central" font-size="${LBL}" fill="${_EXP.ink}">${_sx(rowLabels[ri])}</text>${cells}`;
    }).join('');

    const frameRect = `<rect x="${gridX}" y="${headerH}" width="${gridW}" height="${gridH}" fill="none" stroke="${_EXP.rule}" stroke-width="1.2"/>`;
    const noun = mode === 'document' ? 'documents' : `${mode}s`;
    const trunc = (topThemes.length < allThemes.length || topDocs.length < allDocs.length)
        ? ` · showing ${topThemes.length}/${allThemes.length} themes × ${topDocs.length}/${allDocs.length} ${noun}` : '';
    return _expFrame({
        title: `Theme × ${MATRIX_GROUP_LABELS[mode]} Matrix`,
        subtitle: `annotation count per theme per ${
            mode === 'year' ? 'year of publication, in time order'
            : mode === 'type' ? 'annotation type, most-coded first'
            : 'paper, most-coded first'}${trunc}`,
        bodyW, bodyH, body: headers + rows + frameRect,
    });
}

/* The network is drawn to fit its labels, not to the canvas box.  Exporting the
   canvas' own W×H cropped every theme name that settled near an edge, and gave
   whatever pan and zoom happened to be active at the time. */
function _buildNetworkSvg() {
    if (!_netState || _netState.canvas?.id !== _analysisNetworkCanvasId()) return null;
    const { nodes, edgeList, idxMap, maxW, edgeStyle } = _netState;
    if (!nodes.length || !edgeList.length) return null;

    const LBL = 12;
    const labels = nodes.map(n => _ellipsize(n.name, LBL, 170, 700));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    nodes.forEach((n, i) => {
        const half = Math.max(n.r, _tw(labels[i], LBL, 700) / 2);
        x0 = Math.min(x0, n.x - half);
        x1 = Math.max(x1, n.x + half);
        y0 = Math.min(y0, n.y - n.r - 2);
        y1 = Math.max(y1, n.y + n.r + 6 + LBL);
    });
    const M = 14;
    const ox = -x0 + M, oy = -y0 + M;
    const bodyW = (x1 - x0) + M * 2;
    const bodyH = (y1 - y0) + M * 2;

    const dashMap = { solid: '', dashed: ' stroke-dasharray="8 5"', dotted: ' stroke-dasharray="2 4"' };
    const dash = dashMap[_netState.edgeDash] || '';
    const edgeColor = _netState.edgeColor === 'auto' ? '#94a3b8' : _netState.edgeColor;

    const edges = edgeList.map(e => {
        const a = nodes[idxMap[e.s]], b = nodes[idxMap[e.t]];
        if (!a || !b) return '';
        const lw = Math.max(1, (e.w / maxW) * 7).toFixed(2);
        const ax = a.x + ox, ay = a.y + oy, bx = b.x + ox, by = b.y + oy;
        let d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} L ${bx.toFixed(1)} ${by.toFixed(1)}`;
        let lx = (ax + bx) / 2, ly = (ay + by) / 2;
        if (edgeStyle === 'curved') {
            const dx = bx - ax, dy = by - ay;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const bend = Math.min(len * 0.35, 70);
            const cpx = (ax + bx) / 2 - (dy / len) * bend;
            const cpy = (ay + by) / 2 + (dx / len) * bend;
            d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} Q ${cpx.toFixed(1)} ${cpy.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
            lx = 0.25 * ax + 0.5 * cpx + 0.25 * bx;
            ly = 0.25 * ay + 0.5 * cpy + 0.25 * by;
        } else if (edgeStyle === 'elbow') {
            const mx = (ax + bx) / 2;
            d = `M ${ax.toFixed(1)} ${ay.toFixed(1)} L ${mx.toFixed(1)} ${ay.toFixed(1)} L ${mx.toFixed(1)} ${by.toFixed(1)} L ${bx.toFixed(1)} ${by.toFixed(1)}`;
            lx = mx; ly = ay;
        }
        return `<path d="${d}" fill="none" stroke="${edgeColor}" stroke-width="${lw}" stroke-linecap="round" opacity="0.6"${dash}/>` +
            (e.w > 1 ? `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="9" fill="${_EXP.muted}" stroke="${_EXP.bg}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${e.w}</text>` : '');
    }).join('');

    const nodeEls = nodes.map((n, i) => {
        const x = (n.x + ox).toFixed(1), y = (n.y + oy).toFixed(1);
        return `<g>
            <circle cx="${x}" cy="${y}" r="${n.r.toFixed(1)}" fill="${n.color}" fill-opacity="0.85" stroke="${n.color}" stroke-width="2"/>
            <text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="${Math.max(9, n.r * 0.62).toFixed(1)}" font-weight="700" fill="#fff">${n.count}</text>
            <text x="${x}" y="${(n.y + oy + n.r + 6).toFixed(1)}" text-anchor="middle" dominant-baseline="hanging" font-size="${LBL}" font-weight="700" fill="${_EXP.ink}" stroke="${_EXP.bg}" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke">${_sx(labels[i])}</text>
        </g>`;
    }).join('');

    return _expFrame({
        title: 'Theme Relationship Network',
        subtitle: `node size = theme frequency · edge width = co-occurrence · ${nodes.length} themes, ${edgeList.length} link${edgeList.length !== 1 ? 's' : ''}`,
        bodyW, bodyH, body: edges + nodeEls,
    });
}

/* ── Shared analysis derivations ─────────────────────────────────────────────
   The CSV and the image for a card come from one function each, so a file can
   never describe a different corpus from the picture it sits beside. */

function _wordFrequencyRows() {
    const wc = {};
    _projectAnalysisAnnotations().forEach(a => {
        _contentWords(_analysisText(a)).forEach(w => { wc[w] = (wc[w] || 0) + 1; });
    });
    return Object.entries(wc).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function _coocActiveMetric() {
    return _coocMetric === 'jaccard' ? 'jaccard' : 'count';
}

function _coOccurrenceRows() {
    const items = _projectAnalysisAnnotations();
    const pairs = {}, totals = {};
    items.forEach(a => {
        const tags = a.tags || [];
        tags.forEach(t => { totals[t.tag_id] = (totals[t.tag_id] || 0) + 1; });
        for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
            const key = [tags[i].tag_id, tags[j].tag_id].sort((x, y) => x - y).join('-');
            if (!pairs[key]) pairs[key] = { a: tags[i], b: tags[j], count: 0 };
            pairs[key].count++;
        }
    });
    Object.values(pairs).forEach(p => {
        const union = (totals[p.a.tag_id] || 0) + (totals[p.b.tag_id] || 0) - p.count;
        p.jaccard = union > 0 ? p.count / union : 0;
    });
    const metric = _coocActiveMetric();
    const sorted = Object.values(pairs).sort((x, y) =>
        metric === 'jaccard' ? (y.jaccard - x.jaccard) || (y.count - x.count) : (y.count - x.count));
    return { pairs: sorted, metric };
}

/* Ranked by how much coding each document carries.  Taking the first eight in
   insertion order meant the API's item_key ordering picked the sample — stable,
   but not the eight documents anyone would choose to look at. */
function _codingDensityDocs() {
    const byDoc = {};
    _projectAnalysisAnnotations().forEach(a => {
        if (!byDoc[a.item_key]) byDoc[a.item_key] = { key: a.item_key, title: a.item_title || a.item_key, pages: {} };
        const p = a.page_index ?? 0;
        byDoc[a.item_key].pages[p] = (byDoc[a.item_key].pages[p] || 0) + 1;
    });
    return Object.values(byDoc).map(d => {
        const counts = Object.values(d.pages);
        return {
            ...d,
            total: counts.reduce((s, v) => s + v, 0),
            maxPage: Math.max(...Object.keys(d.pages).map(Number)),
            maxCount: Math.max(...counts),
        };
    }).sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
}

function _sentimentBreakdown(items) {
    let manualCount = 0;
    const tagged = items.map(a => {
        if (a.sentiment) { manualCount++; return { ...a, _sent: a.sentiment, _manual: true }; }
        return { ...a, _sent: _scoreSentiment(_analysisText(a)) || 'none', _manual: false };
    });
    const count = k => tagged.filter(a => a._sent === k).length;
    const segs = [
        { label: 'Positive', key: 'pos', count: count('pos'), color: '#22c55e' },
        { label: 'Neutral', key: 'neu', count: count('neu'), color: '#94a3b8' },
        { label: 'Negative', key: 'neg', count: count('neg'), color: '#ef4444' },
        { label: 'Not scored', key: 'none', count: count('none'), color: '#cbd5e1' },
    ].filter(s => s.count > 0);
    return { tagged, segs, total: tagged.length, manualCount, none: count('none') };
}

function _sentimentThemes(tagged) {
    const scores = {};
    tagged.forEach(a => (a.tags || []).forEach(t => {
        if (!scores[t.tag_id]) scores[t.tag_id] = { ...t, pos: 0, neg: 0, neu: 0, none: 0, total: 0 };
        scores[t.tag_id][a._sent]++;
        scores[t.tag_id].total++;
    }));
    return Object.values(scores).sort((a, b) => b.total - a.total);
}

function _tfidfThemes(themeLimit, termLimit) {
    const corpus = {};
    _projectAnalysisAnnotations().forEach(a => {
        const words = _contentWords(_analysisText(a));
        (a.tags || []).forEach(t => {
            if (!corpus[t.tag_id]) corpus[t.tag_id] = { ...t, words: [] };
            corpus[t.tag_id].words.push(...words);
        });
    });
    const themes = Object.values(corpus).filter(t => t.words.length >= 5);
    if (!themes.length) return [];
    const N = themes.length;
    const docFreq = {};
    themes.forEach(t => new Set(t.words).forEach(w => { docFreq[w] = (docFreq[w] || 0) + 1; }));
    themes.forEach(t => {
        const tf = {};
        t.words.forEach(w => { tf[w] = (tf[w] || 0) + 1; });
        const total = t.words.length;
        t.tfidf = Object.entries(tf)
            .map(([w, f]) => ({ w, score: (f / total) * Math.log((N + 1) / (docFreq[w] || 1)) }))
            .filter(x => x.score > 0.0001)
            .sort((a, b) => b.score - a.score)
            .slice(0, termLimit);
        t.maxScore = t.tfidf[0]?.score || 1;
    });
    return themes
        .sort((a, b) => b.words.length - a.words.length)
        .slice(0, themeLimit)
        .filter(t => t.tfidf.length);
}

/* ── Data (CSV) exports ──────────────────────────────────────────────────────*/

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

/* The chart shows the top 25; the file carries every distinct word, because
   deciding where the tail stops being interesting is the researcher's call. */
function exportProjectWordFrequencyData() {
    const rows = _wordFrequencyRows();
    if (!rows.length) { alert('No text to analyse yet.'); return; }
    const total = rows.reduce((s, [, n]) => s + n, 0);
    _downloadTextFile(
        `word_frequency_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`,
        '﻿' + _csv([
            ['rank', 'word', 'count', 'share_of_content_words_pct'],
            ...rows.map(([w, n], i) => [i + 1, w, n, (n / total * 100).toFixed(3)]),
        ]),
        'text/csv;charset=utf-8;',
    );
}

/* Both metrics travel together: the card shows one at a time, and a file that
   only carried the active one could not be checked against the other. */
function exportProjectCoOccurrenceData() {
    const { pairs } = _coOccurrenceRows();
    if (!pairs.length) { alert('Tag multiple themes on the same annotation to see co-occurring pairs.'); return; }
    _downloadTextFile(
        `theme_cooccurrence_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`,
        '﻿' + _csv([
            ['theme_a_id', 'theme_a', 'theme_b_id', 'theme_b', 'co_occurrences', 'jaccard'],
            ...pairs.map(p => [p.a.tag_id, p.a.name, p.b.tag_id, p.b.name, p.count, p.jaccard.toFixed(4)]),
        ]),
        'text/csv;charset=utf-8;',
    );
}

/* One row per page that carries coding, not one row per document: a density
   figure is only reproducible if the page numbers behind it are in the file. */
function exportProjectCodingDensityData() {
    const docs = _codingDensityDocs();
    if (!docs.length) { alert('No annotations to export.'); return; }
    const rows = docs.flatMap(d => Object.entries(d.pages)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([p, c]) => [d.title, d.key, Number(p) + 1, c, d.total, d.maxPage + 1]));
    _downloadTextFile(
        `coding_density_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`,
        '﻿' + _csv([
            ['document', 'item_key', 'page', 'annotations_on_page', 'annotations_in_document', 'last_coded_page'],
            ...rows,
        ]),
        'text/csv;charset=utf-8;',
    );
}

/* Scored the same way the card scores: an annotation whose text contains no word
   this lexicon knows is reported as "none", not quietly filed under neutral. */
function exportProjectSentimentData() {
    const items = _projectAnalysisAnnotations();
    if (!items.length) { alert('No annotations to export.'); return; }
    const { tagged } = _sentimentBreakdown(items);
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
    const themes = _tfidfThemes(Infinity, 10);
    if (!themes.length) { alert('Not enough coded annotations to compute TF-IDF.'); return; }
    const rows = themes.flatMap(t => t.tfidf.map(({ w, score }) => [t.name, w, score.toFixed(4)]));
    _downloadTextFile(
        `tfidf_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`,
        '﻿' + _csv([['theme', 'word', 'tfidf_score'], ...rows]),
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
    // Same grouping the card is showing, so the file matches the picture.
    const topDocs = _matrixGroups(items).entries;
    if (!topThemes.length || !topDocs.length) { alert('Not enough data to export matrix.'); return; }
    const matrix = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!matrix[t.tag_id]) matrix[t.tag_id] = {};
        const k = _matrixGroupOf(a).key;
        matrix[t.tag_id][k] = (matrix[t.tag_id][k] || 0) + 1;
    }));
    const header = ['theme', ...topDocs.map(([, title]) => title)];
    const rows = topThemes.map(t => [t.name, ...topDocs.map(([k]) => matrix[t.tag_id]?.[k] || 0)]);
    _downloadTextFile(
        `theme_${_matrixGroupBy}_matrix_${_projectAnalysisSlug()}_${_exportDateStamp()}.csv`,
        '﻿' + _csv([header, ...rows]),
        'text/csv;charset=utf-8;',
    );
}

/* ── Image export entry points ───────────────────────────────────────────────*/

function _exportChart(build, base, kind, emptyMessage) {
    const svg = build();
    if (!svg) { alert(emptyMessage); return; }
    const name = `${base}_${_projectAnalysisSlug()}_${_exportDateStamp()}`;
    if (kind === 'svg') _downloadTextFile(`${name}.svg`, svg, 'image/svg+xml;charset=utf-8;');
    else _svgAsPng(svg, `${name}.png`);
}

const _NO_CHART = 'Open the analysis view first so the chart can be exported.';

function exportProjectThemeFrequencySvg() { _exportChart(_buildThemeFrequencySvg, 'theme_frequency', 'svg', 'No theme data to export.'); }
function exportProjectThemeFrequencyPng() { _exportChart(_buildThemeFrequencySvg, 'theme_frequency', 'png', 'No theme data to export.'); }

function exportProjectWordFrequencySvg() { _exportChart(_buildWordFrequencySvg, `word_frequency_${_wfActiveMode()}`, 'svg', 'No text to analyse yet.'); }
function exportProjectWordFrequencyPng() { _exportChart(_buildWordFrequencySvg, `word_frequency_${_wfActiveMode()}`, 'png', 'No text to analyse yet.'); }

function exportProjectCoOccurrenceSvg() { _exportChart(_buildCoOccurrenceSvg, `theme_cooccurrence_${_coocActiveMetric()}`, 'svg', 'Tag multiple themes on the same annotation to see co-occurring pairs.'); }
function exportProjectCoOccurrencePng() { _exportChart(_buildCoOccurrenceSvg, `theme_cooccurrence_${_coocActiveMetric()}`, 'png', 'Tag multiple themes on the same annotation to see co-occurring pairs.'); }

function exportProjectCodingDensitySvg() { _exportChart(_buildCodingDensitySvg, 'coding_density', 'svg', 'No annotations to export.'); }
function exportProjectCodingDensityPng() { _exportChart(_buildCodingDensitySvg, 'coding_density', 'png', 'No annotations to export.'); }

function exportProjectSaturationSvg() { _exportChart(_buildSaturationSvg, 'theme_saturation', 'svg', 'No themed annotations to chart yet.'); }
function exportProjectSaturationPng() { _exportChart(_buildSaturationSvg, 'theme_saturation', 'png', 'No themed annotations to chart yet.'); }

function exportProjectSentimentSvg() { _exportChart(_buildSentimentSvg, 'annotation_sentiment', 'svg', 'No annotations to score.'); }
function exportProjectSentimentPng() { _exportChart(_buildSentimentSvg, 'annotation_sentiment', 'png', 'No annotations to score.'); }

function exportProjectTFIDFSvg() { _exportChart(_buildTFIDFSvg, 'tfidf', 'svg', 'Not enough coded annotations to generate TF-IDF chart.'); }
function exportProjectTFIDFPng() { _exportChart(_buildTFIDFSvg, 'tfidf', 'png', 'Not enough coded annotations to generate TF-IDF chart.'); }

function exportProjectDocumentMatrixSvg() { _exportChart(_buildDocumentMatrixSvg, `theme_${_matrixGroupBy}_matrix`, 'svg', 'Not enough data to generate matrix.'); }
function exportProjectDocumentMatrixPng() { _exportChart(_buildDocumentMatrixSvg, `theme_${_matrixGroupBy}_matrix`, 'png', 'Not enough data to generate matrix.'); }

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
