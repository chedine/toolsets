# fresh identities each run, substituted across all 127 steps (incl. the
# names Curam injects into question labels and the radio option)
param jasonFName  = gen firstName
param jasonLName  = gen lastName
param jasonSSN    = gen ssn
param juniorFName = gen firstName
param juniorSSN   = gen ssn
replace "Jason" with jasonFName
replace "Singleton" with jasonLName
replace "152323223" with jasonSSN
replace "Junior" with juniorFName
replace "152323224" with juniorSSN

click section "HCR Cases and Outcomes"
toggle shortcuts panel
click shortcutgroup "Registration"
click shortcutitem Registration > Person
enter "Jason" as First Name
click button "Next"
enter "Singleton" as Last Name
enter "152323223" as Social Security Number
enter "152323223" as Enter the Social Security number again to confirm. Numbers must match.
select "Male" for Gender
enter "01/01/1966" as Dateof Birth
select "English" for Preferred Language
select "Mail" for Preferred Communication
enter "123" as Apt/Suite
enter "ABC Street" as Street 1
enter "eagan" as City
select "Dakota" for County
select "Minnesota" for State
enter "55124" as Zip
click button "Save"
click tabmenu "New Application"
click button "Next"
check "I agree that I have read and understand my rights and responsibilities described in the warning. I understand that if I do not want to provide income information, I can apply for insurance coverage without income assistance or tax credits by signing out and using the "Apply for health coverage WITHOUT financial help" link. "
click button "Next"
click button "Next"
select "Divorced" for Marital Status
select "Yes" for Do you live in Minnesota?
select "Yes" for Do you plan to make Minnesota your home?
select "No" for Are you temporarily absent from Minnesota?
select "No" for Are you homeless?
select "Yes" for Is the mailing address the same as your home address?
select "No" for Did you move to Minnesota in the last three months?
select "Mail" for Preferred Contact Method
select "No" for Do you want us to send you a voter registration card?
select "Mail" for How would you prefer to receive notices?
select "No" for Do you want us to send you a form to name someone as your authorized representative?
click button "Next"
select "Yes" for Do you have a Social Security Number?
select "Yes" for Are you a US Citizen?
click button "Next"
select "Yes" for Is this the correct Social Security Number?
click button "Next"
click button "Next"
select "Yes" for Is there anyone else in the household?
click button "Next"
select "Yes" for Are you applying for the person highlighted?
enter "Junior" as First Name
enter "Singleton" as Last Name
select "Male" for Gender
enter "1/1/1995" as Date of Birth
select "Yes" for Does this person live with you?
select "Yes" for Does this person plan to make Minnesota his/her home?
select "No" for Is this person temporarily absent from Minnesota?
select "No" for Did this person move to Minnesota in the last three months?
click button "Next"
select "Never Married" for Marital Status
click button "Next"
select "Yes" for Does Junior have a Social Security Number?
enter "152323224" as Social Security Number
enter "152323224" as Enter the Social Security number again to confirm. Numbers must match.
select "Yes" for Is Junior a US Citizen?
click button "Next"
select "Yes" for Is this the correct Social Security Number?
click button "Next"
select "No" for Do you need to add any more people?
click button "Next"
select "Is the Parent of" for Please choose a relationship between Jason and Junior
click button "Next"
check row at row 1
check row at row 1
click button "Next"
select "Yes" for Will Jason be claimed as a tax dependent by anyone else in the household on their tax return ?
select radio "Junior"
click button "Next"
click button "Next"
click button "Next"
select "No" for Does Jason have any income?
click button "Next"
click button "Next"
click button "Next"
select "Yes" for Does Junior have any income?
click button "Next"
select "Wages before taxes" for Income Type
enter "7Brew" as What is the name of your Employer?
select "No" for Is Junior seasonally employed?
enter "5000" as Amount
select "Yearly" for Frequency
select "No" for Does Junior have any more income?
click button "Next"
click button "Next"
click button "Next"
click button "Next"
click button "Next"
click button "Next"
click button "Next"
select "Yes" for Is anyone applying blind?
check row at row 1
select "No" for Does anyone applying have a physical, mental or emotional health condition that limits the ability to perform daily activities?
select "No" for Is anyone applying as an American Indian or Alaska Native?
select "No" for Is anyone visiting Minnesota to get medical care or for personal reasons?
select "No" for Is anyone applying living in a long-term care facility?
select "No" for Is anyone applying in a residential treatment program for mental illness or drug or alcohol dependency?
select "No" for Does anyone applying have Medicare or other non-employer health insurance?
select "No" for Is anyone applying getting services from the Center for Victims of Torture?
select "No" for Does anyone applying want to request a full Medicaid eligibility determination?
select "No" for Is anyone applying seeking services and supports to help with activities of daily living to stay in their home or community through a home and community-based services (HCBS) waiver?
select "No" for Is anyone applying seeking Medicaid payment of long-term care services to reside in a long term care facility?
select "No" for Is anyone getting medical care for an accident or injury?
select "No" for The start date for Medical Assistance(MA) can go back up to three months from your application date if you have medical bills from that time and meet the MA eligibility requirements. Is anyone applying seeking MA for past months?
click button "Next"
select "Yes" for Has Jason been determined blind or disabled by the Social Security Administration (SSA) or the State Medical Review Team (SMRT)?
click button "Next"
select "Yes" for Did Jason meet an exception to the federal work or community engagement requirement last month?
check "Medically Frail or Special Medical Needs"
click button "Next"
select "No" for Did Junior meet an exception to the federal work or community engagement requirement last month?
select "No" for Did Junior complete a qualifying activity last month?
click button "Next"
click button "Next"
check "Confirmed that the client agrees to this renewal policy"
check "Confirmed that the client agrees to adhere to this policy"
check "Confirmed that the client agrees to report changes"
check "Confirmed that the client has read or been made aware of the penalty of perjury"
check "Confirmed that the client agrees to adhere to this policy"
click button "Submit"
check "Confirmed that the client has been made aware of the renewal options and has selected the same."
click button "Submit"
