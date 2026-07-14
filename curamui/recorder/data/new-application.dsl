# New Application from a person tab, filled minimally and SUBMITTED.
# IEG (Insurance Affordability) application wizard for a single-person,
# no-income, US-citizen applicant. The wizard interleaves data pages with
# intro/summary/pass-through pages whose count varies, so we use
# `advance to "<page>"` to skip to each data page instead of counting Next
# clicks. Chain after register-person.dsl on a fresh person:
#   node replay.js register-person.dsl --param firstName=X --param lastName=Y ...
#   node replay.js new-application.dsl  --param firstName=X --param person="X Y"
param firstName = "Zeph"
param person = "Zeph Qarlson"
# on/before the server clock (the prefill goes stale if the clock moves back)
param appDate = "1/1/2026"
click section "HCR Cases and Outcomes"
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "${firstName}" as First Name
click button "Search"
click link "${person} - *" in "Search Results"
click tabmenu "New Application"

# --- Application Filing Date ---
enter "${appDate}" as Application Date
click button "Next"

# --- Applying for Assistance (rights & responsibilities) ---
check "I agree*"

# --- Information About You (person data prefilled; fill the mandatory rest) ---
advance to "Information About You"
select "Never Married" for Marital Status
select "Yes" for Do you live in Minnesota?
select "Yes" for Do you plan to make Minnesota your home?
select "Mail" for Preferred Contact Method
select "No" for Did you move to Minnesota in the last three months?
select "No" for Are you temporarily absent from Minnesota?
select "No" for Are you homeless?
select "Mail" for How would you prefer to receive notices?
select "No" for Do you want us to send you a form to name someone as your authorized representative?
select "No" for Do you want us to send you a voter registration card?
select "Hennepin" for County
select "Yes" for Is the mailing address the same as your home address?
click button "Next"

# --- More About You (citizenship / SSN) ---
select "Yes" for Are you a US Citizen?
select "Yes" for Do you have a Social Security Number?
click button "Next"

# --- SSN Confirmation (SSN pulled from the person record) ---
select "Yes" for Is this the correct Social Security Number?
click button "Next"

# --- Other Household Members ---
advance to "Other Household Members"
select "No" for Is there anyone else in the household?
click button "Next"

# --- Tax Dependent Information ---
advance to "Tax Dependent Information"
select "No" for Is anyone outside this household expected to enter ${firstName} as a dependent on their tax return?
click button "Next"

# --- Income Information ---
advance to "Income Information"
select "No" for Does ${firstName} have any income?
click button "Next"

# --- Additional Information for all Applicants (all "No") ---
advance to "Additional Information for all Applicants"
select "No" for Is anyone visiting Minnesota to get medical care or for personal reasons?
select "No" for Does anyone applying want to request a full Medicaid eligibility determination?
select "No" for Does anyone applying have Medicare or other non-employer health insurance?
select "No" for Is anyone applying living in a long-term care facility?
select "No" for Does anyone applying have a physical, mental or emotional health condition that limits the ability to perform daily activities?
select "No" for Is anyone applying as an American Indian or Alaska Native?
select "No" for Is anyone getting medical care for an accident or injury?
select "No" for Is anyone applying in a residential treatment program for mental illness or drug or alcohol dependency?
select "No" for Is anyone applying getting services from the Center for Victims of Torture?
select "No" for Is anyone applying seeking services and supports to help with activities of daily living to stay in their home or community through a home and community-based services (HCBS) waiver?
select "No" for Is anyone applying blind?
select "No" for The start date for Medical Assistance(MA) can go back up to three months from your application date if you have medical bills from that time and meet the MA eligibility requirements. Is anyone applying seeking MA for past months?
select "No" for Is anyone applying seeking Medicaid payment of long-term care services to reside in a long term care facility?
click button "Next"

# --- Additional Household Information (community engagement) ---
advance to "Additional Household Information"
select "Yes" for Did ${firstName} meet an exception to the federal work or community engagement requirement last month?
check "Family Caregiver of Disabled Individual"

# --- Summary (IEG review page) then out to the Carbon submit dialogs ---
advance to "Summary"
click button "Next"

# --- Submit Application Form (Carbon modal): 4 consent checkboxes ---
check all
click button "Submit"

# --- Submit Application (renewal consent): duration defaults to "5 Years",
#     plus one confirmation checkbox ---
check all
click button "Submit"
# Submission creates an "Insurance Affordability Application" case (Pending
# Application Cases) + an "Insurance Affordability" case (Current Cases) on
# the person. The in-session person tab is cached, so verify by re-opening
# the person in a fresh run (see PROJECT.md).
