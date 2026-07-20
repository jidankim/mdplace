# mdplace marketplace taxonomy source audit (v1)

Audit date: 2026-07-19

## Scope and evidence rules

This audit asks a narrow question: what do first-party sources from Pinterest, eBay, Airbnb, Shopify, Google Merchant Center, Walmart, Amazon, Alibaba, and Lazada actually establish about taxonomy or classification architecture, and where does the mdplace analogy go beyond the evidence?

The pre-audit claim inventory below records which platforms had already appeared in the local working notes used as research inputs. Those working notes are not part of this branch, so the inventory deliberately omits unavailable file-and-line references; the adjacent first-party citations are the authoritative evidence. “Prior working-note precedent” means that the platform or source claim appeared in those research inputs. “Additional relevant source” means that it did not and is included only as a bounded comparison.

Accepted primary evidence:

- an official developer or help document;
- an official engineering blog;
- a repository owned by the company;
- a research paper written by company researchers about a company system.

An API document proves its public contract, not its hidden implementation. An engineering post or paper proves what the authors reported at publication time, not a permanent current architecture. No platform metric is treated as transferable to mdplace.

## Pre-audit claim inventory

| Platform | Present in prior working notes? | Claim carried into this audit |
| --- | --- | --- |
| Pinterest | Yes | Interest Taxonomy, Pin2Interest, dynamic μ-topics/pincepts, and OmniSearchSage |
| eBay | Yes | Taxonomy API; wrong-category warning |
| Airbnb | Yes | Knowledge graph over an in-house relational store; inventory categorization and travel context |
| Shopify | No | Additional comparison only |
| Google Merchant Center | No | Additional comparison only |
| Walmart | No | Additional comparison only |
| Amazon | No | Additional comparison only |
| Alibaba | No | Additional comparison only |
| Lazada | No | Additional comparison only |

Therefore, Pinterest, eBay, and Airbnb are the only prior working-note precedents. Treating the other six as if the earlier research inputs had cited them would be inaccurate.

## Pinterest

Status: prior working-note precedent.

### Source P1 — Interest Taxonomy

[Interest Taxonomy: A knowledge graph management system for content understanding at Pinterest](https://medium.com/pinterest-engineering/interest-taxonomy-a-knowledge-graph-management-system-for-content-understanding-at-pinterest-a6ae75c203fd) is an official Pinterest Engineering post.

What it supports:

- Pinterest used a curated parent-child interest taxonomy to map Pins, users, and queries into a common classification space for recommendations, search, and advertising.
- The curation representation used RDF and WebProtégé; engineering workflows converted RDF graphs to relational production tables.
- Taxonomy revisions included add, rename, delete, and merge operations.
- Candidate terms and machine-predicted parents were manually reviewed before new nodes were added.
- This directly supports the mdplace patterns “curated hierarchy,” “model-assisted candidate parent,” “human-gated taxonomy changes,” and “logical graph need not mean graph database.”

What it does not support:

- It does not specify mdplace-style evidence records, note frontmatter patches, confidence thresholds, or an Unresolved Placement state.
- It does not show that RDF or WebProtégé is required; Pinterest explicitly produced relational tables for downstream use.
- It does not justify the claim that every classification should be explainable to an end user.

Applicability limit: strong architectural analogy for taxonomy maintenance, but the entities, scale, safety review, and advertising exposure are Pinterest-specific.

### Source P2 — Pin2Interest

[Pin2Interest: A scalable system for content classification](https://medium.com/pinterest-engineering/pin2interest-a-scalable-system-for-content-classification-41a586675ee7) is an official Pinterest Engineering post.

What it supports:

- At publication time, Pin2Interest mapped a corpus reported as 200B+ Pins into a dynamic, highly curated taxonomy.
- Its pipeline separated relatively cheap, high-recall candidate generation from ranking. The post reports at most 200 candidates, averaging 70, before binary-classifier ranking.
- Candidate and ranking features included lexical expansion, co-occurrence, embeddings, text features, hierarchy features, engagement, and context.
- The system was designed to accept new interests without retraining the ranking model, because features could be computed for new interest nodes.
- This supports mdplace’s proposed “retrieve plausible taxonomy nodes, then rank” analogy.

What it does not support:

- It documents no abstention rule, calibrated confidence threshold, user correction loop, or explanation contract.
- A prediction score is not the same thing as an evidence ledger or human-readable reason.
- The reported corpus size is a 2019 statement, not a current count and not a target for mdplace.

Applicability limit: strong for staged retrieval/ranking; weak for mdplace’s proposed abstention and explanation behaviors.

### Source P3 — dynamic μ-topics / pincepts

[Producing Usable Taxonomies Cheaply and Rapidly at Pinterest Using Discovered Dynamic μ-Topics](https://arxiv.org/abs/2301.12520) is a company-authored research paper.

What it supports:

- The paper starts with bottom-up μ-topic discovery and dynamically connects those “pincepts” to queries, Pins, and users.
- Human experts associate taxonomy nodes with a small number of μ-topics; the paper describes this layer as inspectable and easy to modify.
- The abstract reports launching home-decor and fashion-style taxonomies at 94% precision and a 34.8% improvement in search success rate, plus gains in long clicks and saves.
- This supports an optional internal “micro-topic between content and curated category” layer.

What it does not support:

- The metrics do not establish performance on personal notes, small corpora, other languages, or mdplace’s category definitions.
- The paper does not show that a pincept layer is needed in an initial mdplace release.
- The paper does not establish safe automatic taxonomy mutation; human experts remain part of the described workflow.

Applicability limit: strong research analogy for later taxonomy discovery, but not evidence that mdplace should build a full pincept engine now.

### Source P4 — OmniSearchSage

[OmniSearchSage: Multi-Task Multi-Entity Embeddings for Pinterest Search](https://arxiv.org/abs/2404.16260) is a company-authored paper. Pinterest publishes the [OmniSearchSage implementation](https://github.com/pinterest/atg-research/tree/main/omnisearchsage).

What it supports:

- The system jointly learns compatible query, Pin, and product embeddings.
- Representations include LLM-derived captions, historical engagement, and user-curated board text.
- The paper reports deployment across retrieval and ranking and production gains in relevance, engagement, and advertising click-through rate.
- This supports the limited idea that different entity types can be represented in compatible embedding spaces.

What it does not support:

- OmniSearchSage is a search representation system, not a taxonomy classifier.
- It does not validate mdplace’s proposed folder, path, frontmatter, accepted-placement, or negative-example embeddings; those are mdplace extrapolations.
- Its online metrics and serving scale do not predict personal knowledge-management quality.

Applicability limit: a useful representation-learning reference, not direct evidence for taxonomy governance.

Pinterest audit verdict: the four factual summaries carried forward from the prior working notes are traceable. The steps “abstain,” “present why,” and “learn from user corrections” are sensible mdplace design proposals, but they are not established by these Pinterest sources.

## eBay

Status: prior working-note precedent.

### Sources

- [Taxonomy API Overview](https://developer.ebay.com/api-docs/commerce/taxonomy/static/overview.html)
- [Finding categories for a listing](https://developer.ebay.com/api-docs/sell/static/metadata/sell-categories.html)
- [CategorySuggestionResponse](https://developer.ebay.com/api-docs/commerce/taxonomy/types/txn%3ACategorySuggestionResponse)

What they support:

- eBay exposes marketplace-specific category trees whose nodes can be parent or leaf categories.
- Leaf categories have category-specific aspects with value and requirement constraints.
- `getCategorySuggestions` accepts a free-form query, returns leaf categories with ancestor paths, and orders results by eBay’s confidence in relevance.
- The overview states that assigning a listing to the wrong category can “severely damage” or restrict the seller’s ability to sell it. The commercial-risk statement carried forward from the prior working notes is therefore traceable.
- eBay versions category trees and provides expired-to-active category mappings, showing that a production taxonomy evolves.

What they do not support:

- The API does not return a natural-language explanation or provenance for a suggestion.
- Rank order by confidence does not establish calibrated confidence scores or an explicit abstention contract.
- The docs do not require a seller-facing review workflow; an integrating application decides how to present suggestions.
- The prior working notes’ conclusion that classification therefore “must be explainable, reviewable, and not forced when uncertain” is an mdplace design inference, not an eBay-documented rule.

Applicability limit: strong analogy for a versioned hierarchy, leaf-specific constraints, and ranked candidate suggestions; weak analogy for explanation and abstention. eBay category trees also vary by marketplace, so they are not a universal ontology.

## Airbnb

Status: prior working-note precedent.

### Source

[Contextualizing Airbnb by Building Knowledge Graph](https://medium.com/airbnb-engineering/contextualizing-airbnb-by-building-knowledge-graph-b7077e268d5a) is an official Airbnb Engineering post from 2019.

What it supports:

- Airbnb implemented node and edge stores over an in-house relational database, hiding row-level storage behind graph operations. This directly supports mdplace’s “logical graph without a native graph database” analogy.
- Nodes and edges had types and constraints. Edges could include their data source, confidence score, and payload.
- Airbnb stored a hierarchical taxonomy as special graph nodes and applied it across inventory and other travel entities.
- Taxonomy edits required discussion and approval by a cross-functional team.
- The post describes manual tagging, automated inference from metadata and text, and a host confirmation loop for inferred location amenities.
- It also describes graph-powered travel context on search and listing surfaces.

What it does not support:

- It does not benchmark relational storage against a graph database or prove that relational storage is always preferable.
- It does not describe event sourcing, mdplace’s proposal state machine, frontmatter writes, negative evidence, or note-level categorization.
- “Category display can be powered by a graph” is fair as a high-level inference; an exact mdplace projection design is not present in the source.
- The article is a 2019 architecture snapshot. Airbnb’s later graph infrastructure must not be silently substituted for this design.

Applicability limit: one of the strongest references for mdplace’s graph-shaped logical model, source/confidence metadata, human-gated taxonomy changes, and relational backing; still a travel-inventory case study, not a reusable implementation specification.

## Shopify

Status: additional relevant sources; absent from prior working notes.

### Sources

- [Shopify’s Standard Product Taxonomy](https://help.shopify.com/en/manual/products/details/product-category?lang=en-US)
- [Shopify/product-taxonomy](https://github.com/Shopify/product-taxonomy), Shopify’s official open-source taxonomy repository
- [TaxonomyCategory in the Admin GraphQL API](https://shopify.dev/docs/api/admin-graphql/latest/objects/taxonomycategory)

What they support:

- Shopify separates a standardized product category from a merchant-specific product type.
- The standard taxonomy is hierarchical and exposes stable identifiers, names, parent/child/ancestor relationships, leaf status, and category-specific attributes.
- Shopify’s help document describes automatic category suggestions based on product name, description, and images. A merchant can accept or reject a suggestion, browse for a different category, or leave the product `uncategorized`.
- If no standard category fits, a merchant can use the custom product-type field.
- The official GitHub repository publishes source-of-truth category/attribute/value data, generated distributions, releases, mappings to other taxonomies, and a contribution workflow for taxonomy changes.

What they do not support:

- Shopify does not publicly document the suggestion model, its confidence, evidence, or learning from merchant corrections.
- `uncategorized` is a product state, not proof of mdplace’s proposed semantic distinction between “not yet classified” and a user-facing “Uncategorized” category.
- A custom product type is a parallel merchant field, not an abstention result.
- Category metafields and tax/channel rules are commerce-specific typed constraints.

Applicability limit: a strong additional analogy for stable IDs, hierarchy traversal, category-bound attributes, suggestions with accept/reject, and an explicit fallback. It is not evidence for mdplace’s graph or evidence-ledger implementation.

## Google Merchant Center

Status: additional relevant sources; absent from prior working notes.

### Sources

- [Google product category](https://support.google.com/merchants/answer/6324436?hl=en)
- [Product data specification](https://support.google.com/merchants/answer/7052112?hl=en), especially the product-category section

What they support:

- Google automatically assigns products to a continuously evolving Google product taxonomy.
- A merchant may submit one predefined Google category ID or full path and should choose the most specific category matching the product’s main function.
- Google accepts manual overrides only for documented cases, including some category-specific requirements, advertising targeting, and alcohol policy.
- If no Google category fits, or a merchant needs its own organization, Google directs the merchant to the separate `product_type` attribute, which can contain a merchant-defined hierarchy.
- This gives a concrete example of a platform-controlled vocabulary coexisting with a local vocabulary.

What they do not support:

- Google does not expose the automatic classifier, confidence, evidence, or review workflow.
- `product_type` is not a rejection or abstention output; it is a separate merchant-defined field.
- A merchant-supplied Google category is not a free-form proposal, and overrides are explicitly constrained.

Applicability limit: strong additional analogy for external controlled vocabulary versus local categorization and for “one most relevant category.” Weak for explainability, graph structure, or open-ended taxonomy evolution.

## Walmart

Status: additional relevant sources; absent from prior working notes.

### Sources

- [Understanding the requirements for listing an item](https://developer.walmart.com/us-marketplace/docs/understanding-the-requirements-for-listing-an-item)
- [Taxonomy API](https://developer.walmart.com/us-marketplace/reference/gettaxonomyresponse)
- [Get Spec API](https://developer.walmart.com/us-marketplace/reference/getspec)
- [Item-spec versioning and diff reporting](https://developer.walmart.com/us-marketplace/docs/item-spec-versioning-and-diff-reporting)

What they support:

- Walmart documents a three-level product taxonomy: Category → Product Type Group → Product Type.
- Product Types have distinct required attributes and values; the Get Spec API returns specifications for selected Product Types.
- The Taxonomy API is versioned, and Walmart publishes spec versions and diff reports.
- This supports a typed, versioned taxonomy in which a leaf-like product type selects a validation schema.

What they do not support:

- These sources do not document an automatic product-to-taxonomy classifier, ranked category candidates, confidence, explanations, or human review.
- Walmart’s separately named [Get categorization API](https://developer.walmart.com/us-marketplace/docs/get-categorization-api) belongs to assortment recommendations and groups recommended inventory by brand or category. It is not evidence of a listing-category suggestion API and should not be cited as one.
- The docs do not establish a knowledge graph.

Applicability limit: useful additional precedent for versioned category schemas and change diffs; weak for mdplace’s semantic proposal pipeline. The cited endpoints are US Marketplace-specific unless their docs say otherwise.

## Amazon

Status: additional relevant sources; absent from prior working notes.

### Sources

- [Manage Product Listings with the Selling Partner API](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)
- [Search available Product Type Definitions](https://developer-docs.amazon.com/sp-api/docs/search-available-product-type-definitions)
- [Get Product Type Definition recommendations](https://developer-docs.amazon.com/sp-api/docs/get-product-type-definition-recommendations)
- [SP-API release notes](https://developer-docs.amazon.com/sp-api/lang-en_US/docs/sp-api-release-notes), including the product-type and browse-node recommendation documentation
- [Get recommended browse nodes or item type keywords](https://developer-docs.amazon.com/sp-api/docs/get-recommended-browse-nodes-or-item-type-keywords)
- [Catalog Items API](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/catalog-items-api-v2022-04-01-use-case-guide)
- [Notification type values](https://developer-docs.amazon.com/sp-api/docs/notification-type-values), including `ITEM_PRODUCT_TYPE_CHANGE` and `PRODUCT_TYPE_DEFINITIONS_CHANGE`

What they support:

- Amazon exposes marketplace-specific Product Type Definitions as JSON schemas containing attributes and conditional listing requirements.
- Integrators can search available product types for a marketplace and selling-partner account.
- Product Type Definitions can recommend a product type from an item name or keywords.
- The same API publishes recommended browse nodes or item-type keywords for placing a product in a marketplace browse path.
- Catalog Items can return browse classifications and other catalog relationships.
- Amazon emits notifications when an item’s product type changes and when new product types or product-type versions are released.
- This supports recommendation followed by schema retrieval, plus dynamic, machine-readable, marketplace-scoped definitions and change notification.

What they do not support:

- Product types and browse classifications are related catalog structures, but the cited docs do not present them as one simple universal taxonomy tree.
- Amazon exposes recommendation results, but not the underlying recommendation algorithm, calibrated confidence, human-readable explanation, or abstention behavior.
- A product-type-change event proves that classification can change; it does not prove a seller review loop or explain why the change occurred.
- Amazon schemas are listing contracts, not a reusable personal-note taxonomy.

Applicability limit: good additional precedent for recommendation-before-validation, typed constraints, marketplace scope, version awareness, and event-driven change handling; weak for explainable semantic classification and governance.

## Alibaba

Status: additional relevant source; absent from prior working notes. Kept separate from Lazada.

### Sources

[AliCoCo: Alibaba E-commerce Cognitive Concept Net](https://arxiv.org/abs/2003.13230) is a company-authored SIGMOD 2020 paper about an Alibaba production system.

- [Category prediction API (`alibaba.imap.category.predict`)](https://open.alitrip.com/docs/api.htm?apiId=47659)
- [Alibaba.com International category tree API (`alibaba.icbu.category.get.new`)](https://open.alitrip.com/docs/api.htm?apiId=50064)
- [Old-to-new category and attribute mapping API (`alibaba.icbu.category.id.mapping`)](https://open.alitrip.com/docs/api.htm?apiId=52043)

What they support:

- The paper describes Alibaba’s item organization as a Category-Property-Value hierarchy, with properties defined at leaf categories.
- AliCoCo adds layers for items, a manually defined class taxonomy, primitive concepts, and higher-level e-commerce concepts that represent shopping scenarios or user needs.
- Construction combined automated mining and matching with manual checking and active-learning-assisted labeling.
- The authors report production use in Alibaba search and recommendation and distinguish product categories from broader user-need concepts.
- This is a strong additional analogy for keeping bottom-up or user-need concepts distinct from the curated item taxonomy.
- The public category-prediction contract takes a title plus source and target channel/category context, with optional signals such as brand, barcode, and property-value pairs, and returns category paths.
- The International marketplace API exposes parent/child/leaf category structure, and only leaf categories are valid for product publication.
- The mapping endpoint converts old category, attribute, or attribute-value IDs to their replacement IDs after a publishing-schema upgrade.

What they do not support:

- AliCoCo is a 2020 research system, not the current Alibaba.com Open Platform taxonomy contract.
- Its reported scale, precision, and production applications are not evidence for personal-note classification.
- It does not document an mdplace-like proposal object, user acceptance UI, abstention, or frontmatter projection.
- The category-prediction response does not expose calibrated confidence, an explanation, or an abstention state.
- A deterministic old-to-new ID mapping does not establish how Alibaba handles ambiguous splits or semantic migrations.
- Alibaba.com International, Taobao/Open Platform channels, Alibaba Cloud, and Lazada are distinct scopes. These sources do not establish one Alibaba-wide taxonomy.

Applicability limit: strong conceptual analogy for layered concepts plus taxonomy, and a bounded operational precedent for contextual category prediction and explicit migration mappings. It remains weak evidence for mdplace governance and provides no basis for an “Alibaba-wide” taxonomy claim.

## Lazada

Status: additional relevant sources; absent from prior working notes. Kept separate from Alibaba despite corporate ownership.

### Sources

- [Get category tree and category attributes](https://open.lazada.com/apps/doc/doc?docId=120946&nodeId=30715)
- [Create Product Workflow](https://open.lazada.com/apps/doc/doc?docId=120949&nodeId=30720)
- [Product API Overview](https://open.lazada.com/apps/doc/doc?docId=120945&nodeId=29614)
- [Product Category Update Notification](https://open.lazada.com/apps/doc/doc?docId=120209&nodeId=29544)

What they support:

- Lazada exposes a complete tree with category IDs, children, and leaf markers; only leaf categories can be used to create products.
- `GetCategoryAttributes` returns available, mandatory, key, and variant attributes for the selected category.
- `GetCategorySuggestion` recommends a category from a product title.
- Lazada’s creation workflow recommends calling category suggestion because miscategorized products can be deactivated.
- The docs state that category trees and IDs may differ by country. They also document algorithmic auto-fill for unused product attributes, which an API caller can disable.
- Lazada publishes a category-tree update notification so integrations can refresh cached taxonomy data.

What they do not support:

- The public docs do not expose suggestion confidence, ranked evidence, explanations, or an abstention result.
- The deactivation warning is a marketplace enforcement rule, not evidence that Lazada uses uncertainty-aware classification.
- Attribute auto-fill is distinct from category suggestion and should not be described as taxonomy learning.
- Nothing in these sources allows Alibaba’s AliCoCo architecture to be attributed to Lazada.
- The first-party documents are internally inconsistent about regional scope: the product guide says category trees and IDs may differ by country, while the category-update notification says all sites share the same categories. Until Lazada clarifies the version/scope relationship, an integration should key category IDs and cached versions by site or marketplace rather than assuming a global tree.

Applicability limit: strong additional API analogy for leaf-only assignment, category-specific schemas, title-based suggestions, manual control, update notifications, and regional variation. Weak for explanation, graph architecture, or adaptive learning.

## Cross-platform findings

| mdplace design question | Best-supported precedent | Evidence boundary |
| --- | --- | --- |
| Curated hierarchy plus model-assisted mapping | Pinterest; Shopify; eBay; Lazada | Each platform exposes or reports a hierarchy and some form of suggestion/mapping, but only Pinterest publishes significant internal classification architecture. |
| Candidate retrieval before ranking | Pinterest Pin2Interest | Directly supported for Pins; not automatically transferable to notes. |
| Human-gated taxonomy changes | Pinterest; Airbnb; Shopify’s open-source change workflow | Supports governance, not a specific mdplace UI or state machine. |
| Graph-shaped model over relational storage | Airbnb; Pinterest’s RDF-to-relational workflow | Shows feasibility, not performance superiority or necessity. |
| Stable IDs plus category-bound typed attributes | eBay; Shopify; Walmart; Amazon; Lazada | Strong marketplace pattern; attributes are domain-specific and cannot be copied into mdplace. |
| Explicit accept/reject of an automatic suggestion | Shopify | Closest public first-party precedent; no model evidence or confidence is exposed. |
| Platform vocabulary plus local vocabulary | Google (`google_product_category` versus `product_type`); Shopify category versus product type | Strong distinction, but local type is not the same as abstention. |
| Version/change handling | eBay; Shopify; Walmart; Amazon; Alibaba; Lazada | Supports stable identifiers, version awareness, mappings/diffs/events; not full event sourcing. |
| Bottom-up concepts distinct from taxonomy nodes | Pinterest μ-topics; Alibaba AliCoCo | Strong research analogy; costly systems and marketplace/user-interest semantics limit transfer. |
| First-class Unresolved Placement with confidence thresholds | None of these sources | Untraceable as a platform-derived claim. This remains an mdplace design choice that needs independent selective-classification evidence. |
| Human-readable provenance for every classification | None as a complete contract | Airbnb stores edge source/confidence and Pinterest uses review, but neither documents an end-user evidence ledger equivalent to mdplace’s proposal. |

## Claims that should not be made from this evidence

- “All major marketplaces use knowledge graphs for taxonomy.” The public sources do not show this.
- “Marketplace category APIs implement confidence-aware abstention.” No cited API contract does.
- “Alibaba and Lazada share one taxonomy architecture.” No cited source supports that; their evidence is separate.
- “Product-type schemas prove the best architecture for notes.” They show a useful typed-constraint pattern only.
- “Pinterest’s metrics predict mdplace quality.” The tasks, data, scale, and evaluation criteria differ.
- “Airbnb proves a relational database is better than a graph database.” The source reports a pragmatic 2019 choice, not a comparative result.

## Citation-completeness check

- Pinterest: all four prior working-note sources traced; source-specific extrapolations marked.
- eBay: prior working-note Taxonomy API and wrong-category statement traced; explanation/abstention inference marked unsupported.
- Airbnb: prior working-note relational graph and categorization claims traced; 2019 applicability boundary marked.
- Shopify, Google Merchant Center, Walmart, Amazon, Alibaba, Lazada: explicitly marked additional because none appeared in the prior working notes.
- Alibaba and Lazada: audited separately; generic or cross-company attribution rejected.
- All factual platform claims above have an adjacent first-party source. No secondary source is used as final evidence.
