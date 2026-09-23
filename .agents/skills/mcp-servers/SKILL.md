---
name: mcp-servers
description: Карта MCP-серверов проекта (Cloudflare, Vercel, Origene, 21st.dev, Tavily, Context7), обнаружение инструментов и безопасность. Читать перед задачами с MCP.
---

# MCP-серверы: карта возможностей

Ревизия: 2026-09-23, 22:25 UTC. Состав и **номера** интеграций различаются между запусками;
наблюдения ниже относятся к отдельным сеансам, а перечень научных инструментов —
историческая карта, не гарантия доступности.

| Интеграция | Номер в сеансе подготовки 23.09 | Наблюдение |
|---|---|---|
| Cloudflare | `mcp_server_1` | 23 инструмента видны; запрос списка D1 вернул 401. Не пытаться обходить авторизацию |
| Vercel | `mcp_server_2` | 212 инструментов; чтение проектов, деплоев и доменов работало |
| Origene / scientific gateway | `mcp_server_3` | 3574 инструмента отображались при обнаружении |
| Неопознанный сервер | `mcp_server_4` | соединение оборвалось **до** обнаружения инструментов; назначение неизвестно |
| Tavily | не обнаружен | среди работающих серверов этого сеанса не найден; назначение сервера 4 тогда оставалось неизвестным |
| Context7 | `mcp_server_5` | `resolve-library-id`, `query-docs` |
| 21st.dev | `mcp_server_6` | 34 инструмента, включая поиск UI-компонентов |

В следующем сеансе 23.09 конфигурация подписала `mcp_server_4` как Tavily, но
соединение не установилось: его инструменты не были доступны. В архивной карте
от 22.09 номера 4–6 означали **другие** сервисы. Определяйте доступные инструменты
по свежему `*_list_tools`, не вызывайте их по старому номеру или только по ярлыку.

Повторная read-only проверка **23.09.2026, 22:09–22:16 UTC**: обнаружение
инструментов работает у серверов 1, 2, 3, 5 и 6. Vercel (`list_projects`),
Origene (`server_48#health_check`), Context7 (`resolve-library-id`) и 21st.dev
(`get_usage`) ответили. Cloudflare вернул результаты через
`search_cloudflare_documentation`, но `d1_databases_list` дал
**401 Authentication error** — доступ к аккаунту не подтверждён.
`mcp_server_4` помечен платформой как Tavily, соединение отклонено открытым
circuit breaker после повторных ошибок; инструменты недоступны. Эти вызовы
подтверждают конкретные операции, а не исправность всех функций серверов.

**Новый read-only срез ~22:24 UTC после изменения подключения владельцем:**

| Сервис | Номер *только этого сеанса* | Проверка |
|---|---|---|
| Vercel | `mcp_server_1` (212 инструментов) | discovery, без повторного аккаунт-вызова |
| Origene | `mcp_server_2` (3574 инструмента) | discovery, без повторного health |
| Tavily | `mcp_server_3` (5 инструментов) | `tavily_search` вернул результат — поиск работает |
| Context7 | `mcp_server_4` (2 инструмента) | discovery |
| 21st.dev | `mcp_server_5` (34 инструмента) | discovery |
| Cloudflare | `mcp_server_6` (23 инструмента) | `workers_list` и поиск документации ответили; `d1_databases_list` → **401 Authentication error** |

Cloudflare **частично доступен**: успешный Workers read не доказывает D1 read.
Причина 401 не установлена; при необходимости D1 проверить область аккаунта
и разрешение D1 Read у интеграции, не обходить запрет. Tavily был недоступен
в предыдущем сеансе, но **теперь поиск подтвердился**. Повторно проверены
именно эти операции; все номера ниже в исторических разделах остаются
датированными, для нового вызова всегда выполнять discovery.

## Механика вызовов

- Discovery: `mcp_server_N_list_tools(query, limit)`; вызов: `mcp_server_N_call(name, arguments)`.
- В `arguments` передаются **сами параметры инструмента**: например
  `{"idOrName":"itles"}`, а не `{"input":{"idOrName":"itles"}}`, даже если сигнатура
  списка инструментов показана как `tool(input: {...})`. Вложенный `input` для
  `get_project` не проходил валидацию, плоская форма работала.
- У server 3 имя инструмента включает неймспейс: `server_36#BLAST_nucleotide_search`.
- Поиск fuzzy (по токенам): точное совпадение может стоять ПОД нерелевантным мусором
  (пример: probe `server_4#` вернул `server_4#...` только третьим). Правила:
  - «неймспейс существует» = в топ-3 выдачи есть инструмент `server_N#...`;
  - лимит выдачи по output budget ~50–70 записей, offset нет — сужать запрос
    (например `server_36#ADMETAI_`);
  - заголовок «(all matches shown)» даёт точное число совпадений; total в частичной
    выдаче — размер всего сервера, не запроса.

## Server 1 — Cloudflare (23 инструмента)

Аккаунт-операции: D1 (create/get/delete/query/list), KV namespace, R2 bucket,
Hyperdrive, Workers (list/get/code), гайд миграции Pages→Workers,
`search_cloudflare_documentation`. Удаления — только с явного подтверждения.

## Server 2 — Vercel (212 инструментов)

Проекты, деплои, домены, алиасы, роуты, аналитика (`aggregate_events/pageviews`,
`count_*`), rolling releases, checks, API keys, команды, connectors, toolbar-треды.
Покупки (`buy_domain/buy_credits/buy_pro/...`) требуют сначала `get_purchase_quote`
и явной команды пользователя.

## Server 3 — Origene научный шлюз (3574 на 2026-09-22; было 3570 — живой, растёт)

Агрегатор из 47 саб-серверов, имена `server_N#tool`. Существуют: 2–21, 23–45, 47–49.
Отсутствуют: 1, 22, 46, 50+.

| N | Провайдер | Домен / примеры |
|---|-----------|-----------------|
| 2 | DrugSDA-Tool | Структурная биология и докинг: FoldX, MM/PBSA (run/analyze), OpenMM MD, QuickVina, ProteinMPNN, Chai-1, Chroma (monomer/complex/symmetry), EvoBind, LiS-invent, ProLIF, ESMFold-пайплайны, расчеты свойств молекул/PDB, `base64_to_server_file`, CIF→PDB, retrieve PDB by id |
| 3 | DrugSDA-Model | `pred_protein_structure_esmfold(sequence)`, `server_file_to_base64`, `calculate_dleps_score` |
| 4 | Origene-ChEMBL | активности (`get_activity_by_id`), ATC-классы level5 |
| 5 | Origene-KEGG | `kegg_conv` (конверсия между базами KEGG) |
| 6 | Origene-STRING | белок-белковые взаимодействия, `get_functional_enrichment` |
| 7 | Origene-Search | `pubmed_search` |
| 8 | Origene-PubChem | assay summary по CID |
| 9 | Origene-NCBI | проверка genome accessions |
| 10 | Origene-UniProt | 23 инструмента: search/get/stream для UniProtKB, UniParc, UniRef, proteomes, gene-centric |
| 11 | Origene-TCGA | экспрессия гена по типам рака, list cancer types, differential expression |
| 12 | Origene-Ensembl | alignment region, archive id, genetree |
| 13 | Origene-UCSC | `get_chromosome_sequence` |
| 14 | Origene-FDADrug | FDA: имена лекарств по reference/document/application number, abuse info |
| 15 | Origene-OpenTargets | болезни/мишени/лекарства по EFO/Ensembl/ChEMBL id, GO-термины, фармакогеномика, adverse events, mouse models, chemical probes |
| 16 | Origene-Monarch | HPO: фенотип↔ID, joint diseases по списку HPO |
| 17 | BioInfo-Tools | `analyze_protein` (BLAST-подобный анализ последовательности) |
| 18 | Thoth-OP | ⚠️ мокрые лабораторные операции: add, aspirate, aliquot, anneal, balance, centrifuge, digest, dilute, dissolve, elute, extract, filter, freeze, grind, heat, incubate, inoculate... + `exec_code(code_snippet)` — произвольный код |
| 19 | Thoth-Plan | `protocol_generation(user_prompt)`, `generate_executable_json`, `extract_protocol_from_pdf`, `execute_json` — исполнение лабораторных протоколов |
| 20 | 材料力学与断裂分析 | механика материалов (volume from mass, packing factor) |
| 21 | 电学与电路计算 | электротехника (resistor sufficiency, charge) |
| 23 | 光学与电磁学 | оптика/ЭМ (Bragg angle, photon energy) |
| 24 | 化学与反应计算 | химия (bond length/order) |
| 25 | 几何与数学计算 | математика (percentage→decimal, volume) |
| 26 | 数据处理与统计分析 | статистика/ошибки измерений |
| 27 | 物理量与单位换算 | перевод единиц (J↔eV, cm3→m3, W→kW) |
| 28 | InternAgent | AlanineScanningDesigner, Conformation3DAnalyzer |
| 29 | SciToolAgent-Bio | AlanineScanningLibraryDesign, CpGIslandPrediction |
| 30 | SciToolAgent-Mat | CalculateDensity |
| 31 | SciToolAgent-Chem | RDKit-дескрипторы (WHIM, RDF, USR, PBF, CIP...) + ML (AdaBoostClassifier) |
| 32 | SCP-Workflow | `generate_presigned_url` (файловое хранилище), `query_and_filter_tools(prompt)` — семантический поиск по всем 3574 инструментам |
| 33 | SeisOBS-Tool | сейсмология (→ miniseed) |
| 34 | OceanGSW-Tool | океанография TEOS-10 (salinity) |
| 35 | AtmSci-Tool | атмосфера (heatwave check) |
| 36 | ToolUniverse | 🔥 крупнейший неймспейс, сотни обёрток научных API: ADMETAI, Alliance, AllenBrain, AMPSphere, AntibodyRegistry, BioRxiv/MedRxiv, BioSamples, BioPortal, BiGG, BindingDB, BLAST_nucleotide_search, BVBRC, CancerVar, ChEBI, ChIPAtlas, ClinicalCalc, ClinicalTrials, ClinGenAR, CPIC, DailyMed, DataONE, DepMap, Dfam, DiseaseSh, DNA_primer_design, DrugProps_qed, DrugSynergy (BLISS/CI/Loewe), DoseResponse_ic50, EBIProteins, ENAPortal, Ensembl* (VEP, LD, Reg, Var, Map, Compara), Epidemiology, EVA, ExpressionAtlas, FlyBase, GBIF, GEO, GlyGen, GNPS, gProfiler, GOAPI, GxA, GWASSumStats, HGNC, HPO, HuBMAP, IDT_analyze_oligo, iNaturalist, intact, InterPro, InterVar, ISRCTN, ITIS, JPLHorizons, KEGG, L1000FWD, LINCS, LipidMaps, LNCipedia, LOVD, MarineRegions, MassBank, MaveDB, Mcule, MeSH, MetabolomicsWorkbench, MGnify, ModelDB, MODOMICS, Mondo, MonarchV3, MSigDB, MyDisease, NASASBDB, NCIThesaurus, NCBIVariation, NeuroMorpho, NeuroVault, OMA, OpenAlex, OpenFDA, OrthoDB, PDBe, PharmGKB, PharmacoDB, Pfam, PlantReactome, PomBase, Progenetix, ProtacDB, ProtVar, PubChemBioAssay, Reactome, Rfam, RGD, RNAcentral, RxNorm, SGD, SYNERGxDB, ThreeDBeacons, UCSC, UniProtRef/Taxonomy, VDJDB, Xenbase, `download_binary_file`, `advanced_literature_search_agent` |
| 37 | SciGraph | knowledge graph (общий): get_kg_statistics |
| 38 | SciGraph-Bio | knowledge graph bio |
| 39 | SciGraph-MathPhys | knowledge graph math/phys |
| 40 | SciGraph-Material | knowledge graph materials |
| 41 | SciGraph-Earth | knowledge graph earth |
| 42 | Scholar-KG | `query_paper(query, subject)`, list_subjects, download_results — граф научных статей |
| 43 | Sciverse | `search_papers`, `semantic_search`, `read_content`, `list_paper_relations` (CITATIONS/REFERENCES/RELATED_WORKS), list_catalog |
| 44 | GWAS-KG | GWAS knowledge graph |
| 45 | SciGraph-TCM | knowledge graph традиционной китайской медицины |
| 47 | CrystalX | кристаллография: анализ по INS/HKL, upload |
| 48 | DianShi-RxnDB | база химических реакций (health_check) |
| 49 | Server Everything (MCP Apps Public Test) | echo, get-sum, get-tiny-image, dashboard — технический/тестовый |

Проверка server 3 была выборочной: запрос "memory" дал 3 нерелевантных
совпадения, но fuzzy-поиск не доказывает отсутствие инструментов памяти.
Для веб-поиска используйте обнаруженный Tavily или `web_search`, для документации
библиотек — Context7; GitHub — через разрешённый процесс `git`/`gh`.

## 21st.dev (в проверенном запуске — server 6, 34 инструмента)

UI-маркетплейс: `get_inspiration` (поиск компонентов/тем/шаблонов), `get_component`
(код + demo), `get_theme` (CSS-токены), закладки и списки, командные библиотеки,
AI-генерация (get_generation/get_generation_job/get_take), публикация и правка
СОБСТВЕННЫХ компонентов/тем/шаблонов (edit_*/delete_*), `get_usage` (квота).
Удаления/публикации — только по явной команде.

## Tavily (в архивной карте — server 5; в сеансе подготовки 23.09 не обнаружен)

`tavily_search` (веб-поиск: домены, даты, глубина), `tavily_extract` (контент URL),
`tavily_crawl`, `tavily_map` (структура сайта), `tavily_research` (mini/pro/auto —
многоисточниковое исследование). Использовать только если обнаружение и соединение
подтвердили доступ; иначе — разрешённый `web_search` или первоисточники.

## Context7 (в проверенном запуске — server 5, 2 инструмента)

`resolve-library-id` → `query-docs`: актуальная документация библиотек/фреймворков
с примерами. Использовать перед незнакомыми API вместо полагания на память.

## Правила безопасности

1. Thoth-OP / Thoth-Plan (ns 18/19) — действия в физическом мире и `exec_code`:
   только по явной команде пользователя.
2. Покупки Vercel (`buy_*`), удаления (CF/Vercel/21st.dev), публикации — только по
   явной команде; `buy_*` — сначала quote.
3. Чтение и поиск (`get_*`, `search_*`, `list_*`, `query_*`) — свободно в рамках задачи.
4. `get_project_env` и список переменных Vercel могут вернуть зашифрованные значения.
   Для инвентаризации используйте `filter_project_envs` с `decrypt:false`, фиксируйте
   **только имена и области применения**, никогда не вставляйте вывод MCP в код или PR.

## Шпаргалка «что когда»

- Белок/ген/болезнь/лекарство → Origene (в последнем сеансе server 2): UniProt (10), OpenTargets (15), ChEMBL (4),
  PubChem (8), KEGG (5), STRING (6), TCGA (11); in-silico расчёты → DrugSDA-Tool (2).
- Научные статьи → Sciverse (43), Scholar-KG (42), PubMed (7), OpenAlex через ToolUniverse (36).
- Варианты/мутации → ToolUniverse: gnomAD, GenomeNexus, VEP, ClinVar-подобные.
- Веб-поиск → Tavily, если доступен после discovery, иначе `web_search`.
- Документация библиотеки → Context7 (в последнем сеансе server 4).
- Cloudflare-инфраструктура → Cloudflare (в последнем сеансе server 6; Workers
  отвечает, D1 возвращает 401); Vercel деплой/домены/аналитика → Vercel (server 1).
- UI-компоненты/темы → 21st.dev (в последнем сеансе server 5).
- Не знаешь, какой инструмент Origene нужен → `server_32#query_and_filter_tools(prompt)`
  или list_tools с query по смыслу (fuzzy!).

## Перепроверка карты

Числа дрейфуют. Обновлять: total — `list_tools` без query (limit 1, заголовок);
существование неймспейса — probe `server_N#` limit 3; содержимое — query `server_N#`
с большим limit (помнить про output budget).
