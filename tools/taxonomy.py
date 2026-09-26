"""Owned peer-group taxonomy for the S&P 900 (S&P 500 + S&P MidCap 400).

FMP labels S&P 500 constituents with its own sector/industry strings and the
S&P 400 list (Wikipedia) uses GICS names. SECTOR_ALIAS folds the GICS sector
names into FMP's so both indexes share 11 sectors. PEER_GROUPS maps every
FMP/GICS industry string seen in the universe to one of 38 peer groups, each
with a fixed parent sector (a few industries are deliberately re-parented, e.g.
homebuilders to Industrials, packaging to Basic Materials, solar equipment to
Industrials). TICKER_OVERRIDES then corrects the names whose vendor industry
label misdescribes the business (e.g. FMP files Rollins under personal products
and GE Vernova under utilities); an override wins over the industry map.

The groups exist for browsing and, more importantly, as regression benchmarks:
each should hold companies with similar economic drivers yet enough names to
form a usable equal-weight benchmark (the model uses a group only when it has
at least nine members). Telecom and Power Producers & Renewables are smaller
than that by construction: they stay as browse labels and their members are
benchmarked against their sector. An industry missing here falls back to its
(aliased) sector and no group; build_data.py reports every such name.

This module is maintenance-time only: the app ships the resolved sector and
group per ticker in data/universe.json and never sees this map.
"""

SECTOR_ALIAS = {"Information Technology": "Technology", "Financials": "Financial Services", "Health Care": "Healthcare",
                "Consumer Discretionary": "Consumer Cyclical", "Consumer Staples": "Consumer Defensive",
                "Materials": "Basic Materials"}
PEER_GROUPS = {
    # Industrials
    "Aerospace & Defense": ("Industrials", ["Aerospace & Defense"]),
    "Machinery & Equipment": ("Industrials", ["Industrial - Machinery", "Industrial Machinery & Supplies & Components",
        "Construction Machinery & Heavy Transportation Equipment", "Agricultural - Machinery", "Agricultural & Farm Machinery",
        "Manufacturing - Tools & Accessories", "Industrial - Pollution & Treatment Controls", "Conglomerates", "Industrial Conglomerates"]),
    "Electrical Equipment": ("Industrials", ["Electrical Components & Equipment", "Electrical Equipment & Parts", "Solar"]),
    "Building & Construction": ("Industrials", ["Building Products", "Construction", "Residential Construction", "Homebuilding",
        "Security & Protection Services"]),
    "Engineering & Construction Services": ("Industrials", ["Construction & Engineering", "Engineering & Construction"]),
    "Transportation": ("Industrials", ["Integrated Freight & Logistics", "Cargo Ground Transportation", "Railroads",
        "Airlines, Airports & Air Services", "Passenger Airlines", "Trucking", "Marine Transportation", "Air Freight & Logistics",
        "Passenger Ground Transportation"]),
    "Commercial & Professional Services": ("Industrials", ["Trading Companies & Distributors", "Industrial - Distribution",
        "Research & Consulting Services", "Diversified Support Services", "Data Processing & Outsourced Services",
        "Staffing & Employment Services", "Specialty Business Services", "Consulting Services", "Waste Management",
        "Rental & Leasing Services", "Environmental & Facilities Services", "Personal Products & Services",
        "Human Resource & Employment Services", "Office Services & Supplies", "Security & Alarm Services"]),
    # Financial Services
    "Banks": ("Financial Services", ["Regional Banks", "Banks - Regional", "Banks - Diversified",
        "Commercial & Residential Mortgage Finance", "Mortgage REITs"]),
    "Insurance": ("Financial Services", ["Insurance - Property & Casualty", "Property & Casualty Insurance", "Insurance - Brokers",
        "Insurance Brokers", "Insurance - Diversified", "Insurance - Life", "Life & Health Insurance", "Reinsurance",
        "Insurance - Reinsurance", "Insurance - Specialty", "Multi-line Insurance"]),
    "Capital Markets & Asset Management": ("Financial Services", ["Asset Management", "Asset Management - Global",
        "Asset Management & Custody Banks", "Financial - Capital Markets", "Investment Banking & Brokerage",
        "Investment - Banking & Investment Services", "Financial - Data & Stock Exchanges", "Financial Exchanges & Data",
        "Multi-Sector Holdings", "Diversified Financial Services"]),
    "Consumer Finance & Payments": ("Financial Services", ["Financial - Credit Services", "Transaction & Payment Processing Services",
        "Consumer Finance"]),
    # Technology
    "Semiconductors": ("Technology", ["Semiconductors", "Semiconductor Materials & Equipment"]),
    "Application Software": ("Technology", ["Software - Application", "Application Software", "Electronic Gaming & Multimedia"]),
    "Infrastructure & Systems Software": ("Technology", ["Software - Infrastructure", "Systems Software", "Internet Services & Infrastructure"]),
    "Hardware & Components": ("Technology", ["Hardware, Equipment & Parts", "Computer Hardware", "Communication Equipment",
        "Communications Equipment", "Electronic Manufacturing Services", "Electronic Equipment & Instruments", "Electronic Components",
        "Consumer Electronics"]),
    "IT Services & Distributors": ("Technology", ["Information Technology Services", "Technology Distributors", "IT Consulting & Other Services"]),
    # Consumer Cyclical
    "Retail": ("Consumer Cyclical", ["Specialty Retail", "Automotive Retail", "Apparel - Retail", "Apparel Retail", "Home Improvement",
        "Home Improvement Retail", "Specialty Stores", "Other Specialty Retail", "Broadline Retail", "Computer & Electronics Retail",
        "Homefurnishing Retail", "Auto - Dealerships", "Distributors"]),
    "Restaurants": ("Consumer Cyclical", ["Restaurants"]),
    "Hotels, Travel & Leisure": ("Consumer Cyclical", ["Hotels, Resorts & Cruise Lines", "Travel Services",
        "Gambling, Resorts & Casinos", "Casinos & Gaming", "Travel Lodging", "Leisure", "Leisure Facilities", "Education Services",
        "Specialized Consumer Services"]),
    "Autos & Consumer Durables": ("Consumer Cyclical", ["Automotive Parts & Equipment", "Auto - Parts", "Auto - Manufacturers",
        "Leisure Products", "Household Appliances", "Home Furnishings", "Motorcycle Manufacturers"]),
    "Apparel & Luxury": ("Consumer Cyclical", ["Apparel, Accessories & Luxury Goods", "Apparel - Footwear & Accessories", "Footwear",
        "Apparel - Manufacturers", "Luxury Goods"]),
    # Healthcare
    "Pharma & Biotech": ("Healthcare", ["Biotechnology", "Drug Manufacturers - General", "Drug Manufacturers - Specialty & Generic", "Pharmaceuticals"]),
    "Medical Devices & Supplies": ("Healthcare", ["Medical - Devices", "Medical - Instruments & Supplies", "Health Care Equipment", "Health Care Supplies"]),
    "Diagnostics & Life Science Tools": ("Healthcare", ["Medical - Diagnostics & Research", "Life Sciences Tools & Services"]),
    "Providers & Health Services": ("Healthcare", ["Medical - Healthcare Plans", "Managed Health Care", "Medical - Care Facilities",
        "Health Care Facilities", "Health Care Services", "Medical - Distribution", "Medical - Healthcare Information Services",
        "Health Care Technology"]),
    # Real Estate
    "Property REITs": ("Real Estate", ["REIT - Retail", "REIT - Residential", "Health Care REITs", "Industrial REITs", "Retail REITs",
        "Office REITs", "REIT - Healthcare Facilities", "REIT - Industrial", "REIT - Office", "Single-Family Residential REITs",
        "Real Estate - Services", "REIT - Diversified", "REIT - Hotel & Motel", "Diversified REITs", "Real Estate Services",
        "Multi-Family Residential REITs", "Hotel & Resort REITs"]),
    "Specialty REITs": ("Real Estate", ["REIT - Specialty", "Other Specialized REITs", "Timber REITs"]),
    # Utilities
    "Regulated Utilities": ("Utilities", ["Regulated Electric", "Gas Utilities", "Multi-Utilities", "Electric Utilities",
        "Diversified Utilities", "Regulated Gas", "Regulated Water", "Water Utilities"]),
    "Power Producers & Renewables": ("Utilities", ["Renewable Utilities", "Independent Power Producers",
        "Independent Power Producers & Energy Traders", "Renewable Electricity"]),
    # Consumer Defensive
    "Consumer Staples Products": ("Consumer Defensive", ["Packaged Foods", "Packaged Foods & Meats", "Beverages - Non-Alcoholic",
        "Soft Drinks & Non-alcoholic Beverages", "Beverages - Wineries & Distilleries", "Food Confectioners", "Tobacco",
        "Agricultural Farm Products", "Agricultural Products & Services", "Household & Personal Products", "Personal Care Products"]),
    "Staples Retail & Distribution": ("Consumer Defensive", ["Discount Stores", "Food Retail", "Food Distributors", "Food Distribution",
        "Grocery Stores", "Consumer Staples Merchandise Retail"]),
    # Basic Materials
    "Chemicals": ("Basic Materials", ["Chemicals - Specialty", "Specialty Chemicals", "Diversified Chemicals", "Chemicals",
        "Agricultural Inputs", "Fertilizers & Agricultural Chemicals"]),
    "Metals & Mining": ("Basic Materials", ["Steel", "Gold", "Copper", "Silver", "Aluminum", "Diversified Metals & Mining"]),
    "Construction Materials & Packaging": ("Basic Materials", ["Construction Materials", "Paper & Plastic Packaging Products & Materials",
        "Metal, Glass & Plastic Containers", "Packaging & Containers", "Business Equipment & Supplies"]),
    # Energy
    "Upstream & Energy Services": ("Energy", ["Oil & Gas Exploration & Production", "Oil & Gas Integrated", "Oil & Gas Equipment & Services",
        "Oil & Gas Drilling"]),
    "Midstream & Refining": ("Energy", ["Oil & Gas Midstream", "Oil & Gas Storage & Transportation", "Oil & Gas Refining & Marketing"]),
    # Communication Services
    "Media, Entertainment & Interactive": ("Communication Services", ["Entertainment", "Movies & Entertainment", "Broadcasting",
        "Interactive Home Entertainment", "Publishing", "Advertising Agencies", "Internet Content & Information"]),
    "Telecom": ("Communication Services", ["Telecommunications Services"]),
}
# Names whose vendor industry label misdescribes the business. Each entry names
# the peer group; the sector is the group's parent.
TICKER_OVERRIDES = {
    "LULU": "Apparel & Luxury",                               # vertically integrated apparel brand (FMP: specialty retail)
    "GPN": "Consumer Finance & Payments", "FIS": "Consumer Finance & Payments",   # merchant / banking payment processors
    "FISV": "Consumer Finance & Payments", "CPAY": "Consumer Finance & Payments", "XYZ": "Consumer Finance & Payments",
    "GEV": "Electrical Equipment",                            # power equipment maker, not a utility
    "ETN": "Electrical Equipment", "EMR": "Electrical Equipment", "ROK": "Electrical Equipment",   # FMP: 'Industrial - Machinery'
    "AME": "Electrical Equipment", "GNRC": "Electrical Equipment",
    "HWM": "Aerospace & Defense",                             # aerospace fasteners and structures
    "ARMK": "Restaurants",                                    # contract food service
    "HAS": "Autos & Consumer Durables",                       # toys, with MAT (FMP: 'Leisure')
    "DLR": "Specialty REITs", "VICI": "Specialty REITs",      # data-centre / gaming REITs, with EQIX / GLPI
    "GEHC": "Medical Devices & Supplies", "SOLV": "Medical Devices & Supplies",
    "BRKR": "Diagnostics & Life Science Tools", "TECH": "Diagnostics & Life Science Tools", "RGEN": "Diagnostics & Life Science Tools",
    "CSL": "Building & Construction", "AOS": "Building & Construction",   # building products
    "SNPS": "Application Software",                           # EDA, with CDNS
    "LDOS": "Commercial & Professional Services",             # government IT services, with CACI / SAIC / BAH
    "VNOM": "Upstream & Energy Services",                     # mineral royalties (Wikipedia: storage & transportation)
}

INDUSTRY_GROUP = {}
for _g, (_sec, _inds) in PEER_GROUPS.items():
    for _i in _inds:
        assert _i not in INDUSTRY_GROUP, f"industry {_i!r} mapped twice"
        INDUSTRY_GROUP[_i] = (_g, _sec)
for _t, _g in TICKER_OVERRIDES.items():
    assert _g in PEER_GROUPS, f"override {_t}: unknown group {_g!r}"


def classify(sector, industry, ticker=None):
    """(peer group or None, sector). A ticker override or a mapped industry takes
    its group's parent sector; an unmapped industry keeps its own (aliased)
    sector and no group."""
    if ticker in TICKER_OVERRIDES:
        g = TICKER_OVERRIDES[ticker]
        return g, PEER_GROUPS[g][0]
    hit = INDUSTRY_GROUP.get(industry)
    if hit:
        return hit
    return None, SECTOR_ALIAS.get(sector, sector)
