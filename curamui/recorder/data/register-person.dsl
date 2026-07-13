# Register a person (parameterized). MN address, fake SSN.
# SSN: digits only, NO dashes (the field rejects formatted input) and must
# pass SSA validity rules (area 091 works on this dummy data; 728/9xx fail).
#   node replay.js register-person.dsl --param firstName=X --param lastName=Y \
#     --param dob=2/3/1991 --param ssn=091556655
param firstName = "Zeph"
param lastName = "Qarlson"
param dob = "1/1/1990"
param ssn = "091556700"
click section "HCR Cases and Outcomes"
click shortcutgroup "Registration"
click shortcutitem Registration > Person
enter "${firstName}" as First Name
click button "Search"
click button "Next"
enter "${ssn}" as Social Security Number
enter "${ssn}" as SSN.Reenter
enter "${firstName}" as First Name
enter "${lastName}" as Last Name
select "Male" for Gender
enter "${dob}" as Date of Birth
select "English" for Preferred Language
select "Mail" for Preferred Communication
enter "123 Main St" as Street 1
enter "Minneapolis" as City
select "Minnesota" for State
enter "55401" as Zip
click button "Save"
# verify the person now exists
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "${firstName}" as First Name
click button "Search"
expect row in "Search Results" where Date of Birth = "${dob}"
click link "${firstName} ${lastName} - *" in "Search Results"
