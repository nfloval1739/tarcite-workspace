#!/usr/bin/env python3
"""
Seed demo annotations, themes and library items so the analysis dashboard
has enough data to look impressive.  Run once:

    python scripts/seed_demo_data.py
"""

import json, sys, random, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.database import get_connection, create_tag, create_annotation, set_annotation_tags, upsert_item

# ── helpers ──────────────────────────────────────────────────────────────────

def _insert_item(key, title, authors, year, journal, abstract, doi=""):
    creators = json.dumps([{"lastName": ln, "firstName": fn} for fn, ln in authors])
    upsert_item({
        "item_key": key, "title": title, "creators": creators, "year": str(year),
        "item_type": "journalArticle", "publication_title": journal,
        "doi": doi, "url": "", "abstract": abstract, "tags": "[]",
        "collection_keys": "[]", "date_modified": "", "extra": "",
        "volume": "", "issue": "", "pages": "", "publisher": "", "place": "",
        "edition": "", "isbn": "", "issn": "", "file_path": "", "source_dir": "",
        "citation_count": random.randint(10, 180), "citation_count_updated_at": "",
    })

def _ann(item_key, page, ann_type, quote, comment, color, created_offset_days=0):
    geo = json.dumps({"x": round(random.uniform(0.05,0.6),3),
                      "y": round(random.uniform(0.05,0.85),3),
                      "width": round(random.uniform(0.2,0.55),3),
                      "height": round(random.uniform(0.02,0.06),3)})
    ts = (datetime.datetime.now() - datetime.timedelta(days=created_offset_days)).strftime("%Y-%m-%d %H:%M:%S")
    ann_id = create_annotation({
        "item_key": item_key, "file_id": None, "page_index": page,
        "annotation_type": ann_type, "color": color, "quote": quote,
        "comment": comment, "geometry_json": geo, "source_chunk_id": "",
    })
    # patch created_at
    with get_connection() as conn:
        conn.execute("UPDATE annotations SET created_at=? WHERE annotation_id=?", (ts, ann_id))
    return ann_id

COLORS = {"yellow":"#facc15","blue":"#60a5fa","green":"#34d399","pink":"#f472b6","purple":"#c084fc","orange":"#fb923c"}

# ── 1. LIBRARY ITEMS ─────────────────────────────────────────────────────────

_insert_item(
    "DEMO001",
    "Climate Policy and Institutional Frameworks: Evidence from ASEAN Economies",
    [("James","Smith"),("Aisha","Rahman"),("Carlos","Mendez")],
    2021, "Environmental and Resource Economics",
    "This paper examines the role of institutional quality in shaping effective climate policy across ASEAN economies. Using panel cointegration and CS-ARDL bounds testing over 1995–2020, we find that strong governance significantly amplifies the carbon-reducing effects of environmental regulation. Countries with higher control-of-corruption scores achieve 23% greater emission reductions per unit of policy stringency. Results are robust to cross-sectional dependence and slope heterogeneity.",
    "10.1007/s10640-021-0001"
)

_insert_item(
    "DEMO002",
    "CS-ARDL Bounds Testing in Macroeconomic Panel Analysis: A Methodological Survey",
    [("David","Jones"),("Nurul","Hassan")],
    2020, "Journal of Applied Econometrics",
    "We survey the application of Cross-Sectionally Augmented ARDL (CS-ARDL) estimators in macroeconomic panel settings. The CS-ARDL approach of Chudik and Pesaran (2015) corrects for cross-sectional dependence and slope heterogeneity simultaneously, rendering it superior to pooled mean group estimators under heterogeneous panels. We demonstrate via Monte Carlo simulation that ignoring cross-sectional dependence inflates standard errors by up to 40% and biases long-run coefficients.",
    "10.1002/jae.2020-0002"
)

_insert_item(
    "DEMO003",
    "Economic Growth, Energy Consumption and Carbon Emissions in African Economies: A Panel CS-ARDL Approach",
    [("Kwame","Maroke"),("Fatima","Diallo"),("Jean","Nkosi")],
    2022, "Energy Economics",
    "We investigate the dynamic nexus between GDP growth, energy consumption and CO2 emissions for 38 sub-Saharan African countries from 2000 to 2019. Using the CS-ARDL estimator with cross-sectional augmentation, we confirm a long-run cointegrating relationship. Results reveal a U-shaped Environmental Kuznets Curve (EKC): emissions rise with early-stage industrialisation before declining beyond a per-capita income threshold of USD 4,200 (PPP). Renewable energy substitution accelerates the turning point by approximately 8 years.",
    "10.1016/j.eneco.2022.0003"
)

_insert_item(
    "DEMO004",
    "Institutional Quality, Foreign Direct Investment and Sustainable Development in Sub-Saharan Africa",
    [("Amara","Simpada"),("Hiroshi","Lee"),("Oluwaseun","Adeyemi")],
    2023, "World Development",
    "Foreign direct investment (FDI) flows to Sub-Saharan Africa remain constrained by institutional deficiencies including weak property rights, regulatory uncertainty and corruption. Using a dynamic panel approach with system-GMM and instrumental variable correction for endogeneity, we show that a one-point improvement on the World Bank Governance Index raises FDI-to-GDP by 1.8 percentage points. The effect is non-linear: gains are concentrated in countries that cross a governance threshold associated with 'adequate' rule of law. Policy implications for the African Continental Free Trade Area (AfCFTA) are discussed.",
    "10.1016/j.worlddev.2023.0004"
)

_insert_item(
    "DEMO005",
    "Green Finance, Carbon Markets and the Transition to Net Zero: Mechanisms and Evidence",
    [("Sophie","Laurent"),("Marcus","Wei"),("Priya","Sharma")],
    2023, "Nature Climate Change",
    "Green financial instruments — green bonds, sustainability-linked loans and voluntary carbon markets — have grown exponentially since the Paris Agreement. This paper synthesises evidence from 140 studies and 22 country case studies to assess their real-economy impact on emissions. Meta-regression analysis indicates that green bonds reduce issuer carbon intensity by 7–14% over a five-year horizon, conditional on credible third-party verification. Carbon pricing schemes that include border adjustment mechanisms show the strongest spillover effects across supply chains.",
    "10.1038/s41558-023-0005"
)

print("✓ 5 library items inserted")

# ── 2. THEMES (hierarchical) ─────────────────────────────────────────────────

t_climate   = create_tag("Climate Change",       "#34d399")
t_policy    = create_tag("Policy Response",      "#10b981", t_climate)
t_carbon    = create_tag("Carbon Emissions",     "#6ee7b7", t_climate)
t_ekc       = create_tag("EKC Hypothesis",       "#059669", t_carbon)

t_econ      = create_tag("Econometrics",         "#60a5fa")
t_ardl      = create_tag("CS-ARDL",              "#3b82f6", t_econ)
t_panel     = create_tag("Panel Data",           "#93c5fd", t_econ)
t_gmm       = create_tag("GMM / IV",             "#bfdbfe", t_econ)

t_inst      = create_tag("Institutions",         "#f472b6")
t_gov       = create_tag("Governance",           "#ec4899", t_inst)
t_fdi       = create_tag("FDI",                  "#fda4af", t_inst)
t_corrupt   = create_tag("Corruption",           "#fb7185", t_inst)

t_green     = create_tag("Green Finance",        "#a78bfa")
t_bonds     = create_tag("Green Bonds",          "#8b5cf6", t_green)
t_carbon_mkt= create_tag("Carbon Markets",       "#c4b5fd", t_green)

t_method    = create_tag("Methodology",          "#fb923c")
t_robust    = create_tag("Robustness",           "#f97316", t_method)
t_sim       = create_tag("Monte Carlo",          "#fed7aa", t_method)

print("✓ Themes created")

# ── 3. ANNOTATIONS ───────────────────────────────────────────────────────────
# Format: (page, type, quote, note, color_key, days_ago)
# ~12–15 annotations per paper, mixed types, varied dates

anns_DEMO001 = [
    (0,"highlight","institutional quality in shaping effective climate policy","Core thesis — institutional quality is the mediating variable between policy and outcomes. Sets up the whole paper.",COLORS["green"],45),
    (0,"underline","panel cointegration and CS-ARDL bounds testing","Methodological anchor. CS-ARDL chosen to handle cross-sectional dependence — important justification.",COLORS["blue"],45),
    (0,"comment","","@SmithEtAl2021 abstract is dense but clear. The 23% figure for emission reductions is striking — need to check robustness table.",COLORS["yellow"],44),
    (1,"highlight","strong governance significantly amplifies the carbon-reducing effects","Key finding: governance as moderator. Matches @MaskinEtAl framework on complementary institutions.",COLORS["green"],43),
    (1,"underline","control-of-corruption scores achieve 23% greater emission reductions","Quantitative anchor for the governance–climate nexus. Compare with @Maroke2022 who finds similar threshold effects.",COLORS["blue"],43),
    (2,"highlight","robust to cross-sectional dependence and slope heterogeneity","Robustness claim — explicitly addresses the two main criticisms of panel ARDL methods.",COLORS["orange"],42),
    (2,"underline","environmental regulation stringency index constructed from","Check how they construct the policy index. Composite or single measure?",COLORS["yellow"],42),
    (3,"highlight","ASEAN economies exhibit significant heterogeneity in long-run coefficients","Slope heterogeneity confirmed empirically — justifies MG/PMG over pooled OLS.",COLORS["blue"],41),
    (3,"comment","","The heterogeneity finding is the key motivator for CS-ARDL over simpler estimators. Cross-check with DEMO002 methodology survey.",COLORS["pink"],41),
    (4,"highlight","governance threshold associated with a minimum score of 0.4 on the WGI","Non-linear institutional effect. Below threshold, policy has near-zero effect on emissions.",COLORS["green"],40),
    (4,"underline","countries in the pre-threshold regime show near-zero policy elasticities","Critical for policy: regulation alone is insufficient without baseline governance capacity.",COLORS["orange"],40),
    (5,"highlight","long-run elasticity of emissions with respect to policy stringency is −0.34","Core coefficient. Negative and significant. Compare with meta-analyses.",COLORS["blue"],39),
    (5,"comment","","−0.34 elasticity is conservative relative to European estimates (~−0.6). Could reflect ASEAN's different industrial mix or weaker enforcement.",COLORS["yellow"],38),
    (6,"underline","we employ the Im-Pesaran-Shin panel unit root test allowing for heterogeneous trends","Unit root testing strategy. Heterogeneous trends version is important for avoiding spurious regressions.",COLORS["blue"],37),
    (7,"highlight","policy recommendations: governance reform must precede or accompany","Policy conclusion. Sequencing matters — institutions first, then regulation.",COLORS["green"],36),
]

anns_DEMO002 = [
    (0,"highlight","Cross-Sectionally Augmented ARDL (CS-ARDL) estimators","First formal definition in the paper. CS-ARDL as the core methodological contribution.",COLORS["blue"],60),
    (0,"underline","superior to pooled mean group estimators under heterogeneous panels","PMG comparison — CS-ARDL wins when slopes differ. Key assumption to verify in own data.",COLORS["yellow"],60),
    (0,"comment","","This survey is the go-to reference for justifying CS-ARDL. Cite this when explaining estimator choice in methodology chapter.",COLORS["green"],59),
    (1,"highlight","corrects for cross-sectional dependence and slope heterogeneity simultaneously","The dual correction is what makes CS-ARDL distinctive vs DOLS or FMOLS.",COLORS["blue"],58),
    (1,"underline","Monte Carlo simulation demonstrates size distortions in conventional estimators","Simulation evidence — not just theoretical argument. Stronger justification for the method.",COLORS["orange"],57),
    (2,"highlight","ignoring cross-sectional dependence inflates standard errors by up to 40%","40% inflation is a huge bias. This quantifies the cost of using older methods on modern panels.",COLORS["pink"],56),
    (2,"comment","","Need to check if my own panel (N=38, T=20) falls in the parameter space of their simulations. They use N=20-50, T=15-30 — close match.",COLORS["yellow"],55),
    (3,"highlight","the augmented mean group (AMG) estimator provides a useful robustness check","AMG as alternative to CS-ARDL for robustness. Should run both in my analysis.",COLORS["blue"],54),
    (3,"underline","Pesaran's CD test should be applied prior to model specification","Pre-testing sequence: CD test → unit roots → cointegration → CS-ARDL estimation.",COLORS["green"],53),
    (4,"highlight","long-run coefficients are consistent under slope heterogeneity with T>15","Consistency requirement T>15. My panel has T=20 so this condition is satisfied.",COLORS["blue"],52),
    (4,"comment","","Practical guideline: T>15 is the minimum. With T=20 I am in the valid range. Good.",COLORS["orange"],51),
    (5,"highlight","the cross-sectional averages serve as proxies for unobserved common factors","Theoretical grounding — cross-sectional means as factor proxies. This is Pesaran (2006) CCE logic.",COLORS["blue"],50),
    (5,"underline","lag selection via AIC or BIC with a maximum of two lags recommended","Practical implementation guidance. Use BIC for parsimony in my application.",COLORS["yellow"],49),
    (6,"highlight","bootstrap inference is recommended when T is small relative to N","Bootstrap critical values when T/N ratio is small. Relevant for my African panel.",COLORS["green"],48),
]

anns_DEMO003 = [
    (0,"highlight","U-shaped Environmental Kuznets Curve (EKC): emissions rise with early-stage industrialisation","EKC confirmed for African panel. U-shape rather than inverted-U — important distinction.",COLORS["green"],30),
    (0,"underline","38 sub-Saharan African countries from 2000 to 2019","Sample scope: N=38, T=20. Good coverage. Check which countries are excluded.",COLORS["blue"],30),
    (0,"comment","","This is the key African context paper for my thesis. EKC + CS-ARDL combination directly parallels my own methodology. Cite extensively.",COLORS["pink"],29),
    (1,"highlight","per-capita income threshold of USD 4,200 (PPP)","Turning point USD 4,200 PPP. Most SSA countries are below this — emissions will keep rising in the short run.",COLORS["orange"],28),
    (1,"underline","Renewable energy substitution accelerates the turning point by approximately 8 years","8-year acceleration from renewables. Quantifies the co-benefit of energy transition for development.",COLORS["green"],27),
    (2,"highlight","cointegrating relationship confirmed by Westerlund panel cointegration test","Cointegration established — long-run relationship valid. Check if they use error-correction representation.",COLORS["blue"],26),
    (2,"comment","","Westerlund (2007) test is the right choice here — accounts for cross-sectional dependence unlike Pedroni. Good methodological alignment.",COLORS["yellow"],25),
    (3,"highlight","short-run dynamics are dominated by energy price shocks rather than income effects","Short-run is energy-price driven, long-run is income driven. Different policy levers for each horizon.",COLORS["orange"],24),
    (3,"underline","slope heterogeneity confirmed by the Pesaran-Yamagata delta test","Delta test for slope heterogeneity — formally justifies MG-type estimators.",COLORS["blue"],23),
    (4,"highlight","fossil fuel subsidies significantly delay the EKC turning point","Subsidy removal is critical for accelerating the turning point — strong policy finding.",COLORS["green"],22),
    (4,"comment","","Subsidy finding is directly actionable. Combine with @Simpada2023 governance paper to argue subsidy reform requires institutional capacity.",COLORS["pink"],21),
    (5,"highlight","cross-sectional dependence confirmed by Pesaran CD statistic of 18.4","CD stat of 18.4 >> critical value. Severe CD — validates the choice of CS-ARDL over standard panel methods.",COLORS["blue"],20),
    (5,"underline","the error correction term (ECT) is negative and significant at −0.43","ECT = −0.43: 43% of disequilibrium corrected per year. Moderate speed of adjustment.",COLORS["orange"],19),
    (6,"highlight","resource curse dynamics interact with the EKC in oil-exporting economies","Resource curse complicates EKC for oil exporters. Need to interact oil-exporter dummy in my model.",COLORS["yellow"],18),
    (7,"area","","Figure 3: EKC turning point visualisation by country income group. The three panels show pre/post threshold clearly — use this figure structure for my own results.",COLORS["blue"],17),
]

anns_DEMO004 = [
    (0,"highlight","one-point improvement on the World Bank Governance Index raises FDI-to-GDP by 1.8 percentage points","Main quantitative finding: WGI → FDI elasticity of 1.8pp. Robust and policy-relevant.",COLORS["pink"],15),
    (0,"underline","system-GMM and instrumental variable correction for endogeneity","Endogeneity addressed via sys-GMM. Good — governance itself may be endogenous to FDI.",COLORS["blue"],15),
    (0,"comment","","@Simpada2023 is my anchor paper for the institutions–FDI nexus. The sys-GMM approach here is more rigorous than my current IV strategy — consider adopting.",COLORS["green"],14),
    (1,"highlight","non-linear: gains are concentrated in countries that cross a governance threshold","Non-linearity again. Threshold effects are a running theme across papers — build a conceptual framework.",COLORS["orange"],13),
    (1,"underline","adequate rule of law as the critical threshold condition","Rule of law specifically — not just aggregate WGI. Decompose the governance index in my analysis.",COLORS["yellow"],12),
    (2,"highlight","property rights, regulatory uncertainty and corruption are the binding constraints","Triple constraint framework. Prioritise: property rights > regulatory clarity > anti-corruption.",COLORS["pink"],11),
    (2,"comment","","This ordering of institutional constraints is useful for policy prioritisation. Connects to World Bank Doing Business indicators.",COLORS["blue"],10),
    (3,"highlight","African Continental Free Trade Area (AfCFTA) creates new institutional demands","AfCFTA as institutional catalyst — regional integration raises the stakes for domestic governance.",COLORS["green"],9),
    (3,"underline","Arellano-Bond test for second-order serial correlation: p=0.34","AR(2) test not significant — sys-GMM instruments are valid. Important diagnostic to report.",COLORS["blue"],8),
    (4,"highlight","absorptive capacity: FDI spillovers require a minimum human capital threshold","Human capital as second threshold. FDI needs educated workers to generate productivity spillovers.",COLORS["orange"],7),
    (4,"comment","","Absorptive capacity + governance threshold = two-dimensional threshold space. Consider 3D scatter plot for visualisation.",COLORS["pink"],6),
    (5,"highlight","corruption acts as a tax on investment, raising effective cost of capital","Corruption-as-tax framing. Each corruption percentile raises the risk premium by ~0.3pp.",COLORS["pink"],5),
    (5,"underline","heteroskedasticity-robust standard errors clustered at the country level","Clustering at country level — correct given likely within-country serial correlation.",COLORS["blue"],4),
    (6,"highlight","natural resources are a double-edged sword: attracting FDI while weakening institutions","Resource curse mechanism: resources attract FDI but erode governance capacity simultaneously.",COLORS["orange"],3),
    (6,"comment","","Resource curse ↔ governance ↔ FDI triangle. This is the central tension in my thesis. Map this as a conceptual diagram.",COLORS["yellow"],2),
]

anns_DEMO005 = [
    (0,"highlight","green bonds reduce issuer carbon intensity by 7–14% over a five-year horizon","Core meta-finding: 7–14% carbon reduction from green bonds. Wide confidence interval — depends on verification.",COLORS["purple"],90),
    (0,"underline","conditional on credible third-party verification","Verification is the key moderator. Without it, the effect shrinks to near zero.",COLORS["blue"],90),
    (0,"comment","","Meta-regression across 140 studies — this is a strong evidence base. The verification condition is critical for policy design.",COLORS["green"],89),
    (1,"highlight","Carbon pricing schemes that include border adjustment mechanisms show the strongest spillover effects","Border carbon adjustment (BCA) as the gold standard for spillover prevention.",COLORS["purple"],88),
    (1,"underline","voluntary carbon markets remain plagued by additionality and permanence concerns","Additionality problem in voluntary markets — credits may not represent real reductions.",COLORS["orange"],87),
    (2,"highlight","green bond market grew from USD 36bn in 2014 to USD 580bn in 2022","Exponential growth: 16x in 8 years. Scale is now large enough to matter for real capital allocation.",COLORS["green"],86),
    (2,"comment","","USD 580bn is still <5% of global bond issuance. Scaling challenge remains. What are the barriers to mainstreaming?",COLORS["yellow"],85),
    (3,"highlight","sustainability-linked loans tie coupon rates to ESG performance targets","SLLs create ongoing incentive — not a one-time green label but continuous performance accountability.",COLORS["purple"],84),
    (3,"underline","greenwashing risk is highest in markets without mandatory disclosure frameworks","Mandatory disclosure as the regulatory fix for greenwashing. EU SFDR as emerging best practice.",COLORS["pink"],83),
    (4,"highlight","the additionality criterion requires demonstrating that the investment would not occur under BAU","Additionality definition. Business-as-usual (BAU) counterfactual is inherently unobservable — methodological challenge.",COLORS["orange"],82),
    (4,"comment","","The BAU counterfactual problem is fundamental to carbon credit validity. Propensity score matching or synthetic control could improve estimation.",COLORS["blue"],81),
    (5,"highlight","developing country green bond issuers face a 45–65 basis point premium relative to conventional bonds","Greenium is NEGATIVE in developing markets — they pay MORE for green bonds. Perverse incentive structure.",COLORS["pink"],80),
    (5,"underline","blended finance instruments can bridge the greenium gap through concessional co-investment","Blended finance as the solution. DFIs absorb first-loss to make green bonds viable in frontier markets.",COLORS["purple"],79),
    (6,"highlight","Paris-aligned benchmarks require portfolio decarbonisation of 7% per annum","7% annual decarbonisation target. Aligns with IPCC 1.5°C pathway requirements.",COLORS["green"],78),
    (6,"comment","","7% p.a. decarbonisation is aggressive. Most institutional portfolios currently achieve <1%. The gap is enormous.",COLORS["orange"],77),
    (7,"area","","Figure 4: Waterfall chart of green bond impact by sector. Energy transition accounts for 68% of verified emissions reductions — dominant sector.",COLORS["blue"],76),
]

# tag assignment maps: ann index → list of tag objects to assign
tags_DEMO001 = {
    0:[t_inst,t_policy], 1:[t_ardl,t_panel], 2:[t_method], 3:[t_gov,t_policy,t_climate],
    4:[t_gov,t_corrupt,t_carbon], 5:[t_robust,t_method], 6:[t_method,t_ardl],
    7:[t_panel,t_ardl], 8:[t_ardl,t_method], 9:[t_gov,t_inst], 10:[t_policy,t_carbon],
    11:[t_carbon,t_climate], 12:[t_ekc,t_carbon], 13:[t_panel,t_method,t_robust],
    14:[t_policy,t_gov,t_inst],
}
tags_DEMO002 = {
    0:[t_ardl,t_panel], 1:[t_ardl,t_panel,t_method], 2:[t_ardl,t_method],
    3:[t_ardl,t_panel], 4:[t_method,t_sim], 5:[t_panel,t_ardl],
    6:[t_method,t_ardl,t_panel], 7:[t_robust,t_ardl], 8:[t_method,t_panel],
    9:[t_ardl,t_panel], 10:[t_method,t_panel], 11:[t_ardl,t_method],
    12:[t_method,t_robust], 13:[t_method,t_robust,t_ardl],
}
tags_DEMO003 = {
    0:[t_ekc,t_carbon,t_climate], 1:[t_panel,t_ardl], 2:[t_carbon,t_ekc,t_climate],
    3:[t_ekc,t_carbon], 4:[t_climate,t_policy], 5:[t_ardl,t_panel,t_method],
    6:[t_method,t_ardl,t_robust], 7:[t_policy,t_carbon,t_climate], 8:[t_method,t_panel],
    9:[t_policy,t_climate,t_carbon], 10:[t_policy,t_inst,t_gov], 11:[t_ardl,t_panel,t_method],
    12:[t_ardl,t_panel,t_robust], 13:[t_ekc,t_carbon], 14:[t_ekc,t_method],
}
tags_DEMO004 = {
    0:[t_fdi,t_gov,t_inst], 1:[t_panel,t_gmm], 2:[t_fdi,t_inst,t_gov],
    3:[t_gov,t_fdi,t_inst], 4:[t_gov,t_inst], 5:[t_inst,t_gov,t_corrupt],
    6:[t_corrupt,t_inst], 7:[t_fdi,t_inst,t_policy], 8:[t_gmm,t_method,t_robust],
    9:[t_fdi,t_inst], 10:[t_method,t_panel], 11:[t_corrupt,t_fdi,t_inst],
    12:[t_method,t_robust], 13:[t_fdi,t_inst,t_carbon], 14:[t_fdi,t_inst,t_gov,t_corrupt],
}
tags_DEMO005 = {
    0:[t_bonds,t_green], 1:[t_bonds,t_green,t_method], 2:[t_carbon_mkt,t_green],
    3:[t_bonds,t_green,t_carbon_mkt], 4:[t_carbon_mkt,t_green,t_method],
    5:[t_green,t_bonds], 6:[t_method,t_robust], 7:[t_green,t_bonds],
    8:[t_green,t_policy], 9:[t_carbon_mkt,t_method], 10:[t_method,t_carbon_mkt],
    11:[t_bonds,t_green,t_fdi], 12:[t_bonds,t_green,t_fdi], 13:[t_climate,t_policy,t_green],
    14:[t_climate,t_carbon,t_green], 15:[t_green,t_bonds],
}

def _seed_paper(key, ann_list, tag_map):
    inserted = []
    for i, (page, atype, quote, comment, color, days) in enumerate(ann_list):
        aid = _ann(key, page, atype, quote, comment, color, days)
        tids = [t for t in tag_map.get(i, [])]
        if tids:
            set_annotation_tags(aid, tids)
        inserted.append(aid)
    return inserted

_seed_paper("DEMO001", anns_DEMO001, tags_DEMO001)
_seed_paper("DEMO002", anns_DEMO002, tags_DEMO002)
_seed_paper("DEMO003", anns_DEMO003, tags_DEMO003)
_seed_paper("DEMO004", anns_DEMO004, tags_DEMO004)
_seed_paper("DEMO005", anns_DEMO005, tags_DEMO005)

total = len(anns_DEMO001)+len(anns_DEMO002)+len(anns_DEMO003)+len(anns_DEMO004)+len(anns_DEMO005)
print(f"✓ {total} annotations inserted across 5 papers")
print("Done. Refresh the app and open the Notes → Analysis tab.")
